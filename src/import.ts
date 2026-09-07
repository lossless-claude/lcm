import { readdirSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DaemonClient } from "./daemon/client.js";
import { formatNumber, formatRatio } from "./stats.js";
import { findAllCodexTranscripts } from "./codex-transcript.js";
import type { ProgressState } from "./cli/progress-state.js";
import { projectDbPath, projectId } from "./daemon/project.js";
import {
  appendReplayManifestSessions,
  clearReplayState,
  createReplayRun,
  fingerprintFile,
  isClientGaveUpError,
  loadLatestSessionSummary,
  planReplayResume,
  recordReplayProgress,
  refuseRestartDuringCompaction,
} from "./replay-resume.js";

export type ImportProvider = "claude" | "codex" | "all";

interface ImportOptions {
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  replay?: boolean;
  /** Replay only: discard recorded progress and start from scratch */
  restart?: boolean;
  /** Replay only: model label recorded in the ledger (shown on resume) */
  replayModel?: string;
  /** Which transcript provider to import from (default: "claude") */
  provider?: ImportProvider;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
  /** Called before each session starts; return false to stop the run (e.g. after SIGINT/SIGTERM) */
  onBeforeSession?: () => boolean;
  /** Wrap an in-flight session's work so signal handlers can wait for it before exiting */
  trackInFlight?: () => () => void;
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
  /** Override ~/.lossless-claude path — used in tests only */
  _lcmDir?: string;
  /** Override ~/.codex path — used in tests only */
  _codexDir?: string;
}

export interface ImportResult {
  imported: number;
  skippedEmpty: number;
  failed: number;
  totalMessages: number;
  totalTokens: number;
  tokensAfter: number;
  /** Present when a replay run resumed from a previous run's recorded progress */
  resumed?: { doneCount: number; totalCount: number; model?: string };
  replayUsage?: {
    provider: string;
    model: string;
    calls: number;
    okCalls: number;
    failedCalls: number;
    tokensSpent: number;
    tokensInput: number;
    tokensCached: number;
    tokensOutput: number;
    costUsd?: number;
    callsWithCost: number;
  };
}

export function cwdToProjectHash(cwd: string): string {
  // Claude Code uses the cwd with slashes replaced by dashes, keeping the leading dash
  // e.g. /Users/pedro/Developer/lossless-claude → -Users-pedro-Developer-lossless-claude
  return cwd.replace(/\//g, '-');
}

function buildProjectMap(lcmDir?: string): Map<string, string> {
  const lcmProjectsDir = join(lcmDir ?? join(homedir(), '.lossless-claude'), 'projects');
  const map = new Map<string, string>();
  if (!existsSync(lcmProjectsDir)) return map;
  for (const entry of readdirSync(lcmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(lcmProjectsDir, entry.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.cwd) {
        const hash = cwdToProjectHash(meta.cwd);
        map.set(hash, meta.cwd);
      }
    } catch {}
  }
  return map;
}

export function findSessionFiles(projectDir: string): { path: string; sessionId: string; mtime: number }[] {
  const files: { path: string; sessionId: string; mtime: number }[] = [];
  if (!existsSync(projectDir)) return files;

  // Track which session IDs have a flat (project-root) transcript so we can
  // deduplicate when the same session also has a nested copy.
  const flatSessionIds = new Set<string>();

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    // Layout B (flat): <projectDir>/<session-id>.jsonl
    if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.jsonl')) {
      try {
        const filePath = join(projectDir, entry.name);
        const st = lstatSync(filePath);
        if (st.isSymbolicLink()) continue; // skip symlinks
        const sessionId = basename(entry.name, '.jsonl');
        files.push({
          path: filePath,
          sessionId,
          mtime: st.mtimeMs,
        });
        flatSessionIds.add(sessionId);
      } catch {
        // Skip entries that can't be stat'd (file deleted or permissions issue)
        continue;
      }
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      // Layout A (nested): <projectDir>/<session-id>/<session-id>.jsonl
      const nestedTranscript = join(projectDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nestedTranscript)) {
        try {
          const nestedStat = lstatSync(nestedTranscript);
          if (nestedStat.isSymbolicLink()) {
            // skip symlinks
          } else if (nestedStat.isFile()) {
            files.push({
              path: nestedTranscript,
              sessionId: entry.name,
              mtime: nestedStat.mtimeMs,
            });
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }

      // Subagent transcripts: <projectDir>/<session-id>/subagents/<agent-id>.jsonl
      const subagentsDir = join(projectDir, entry.name, 'subagents');
      if (existsSync(subagentsDir)) {
        for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
          if (sub.isFile() && !sub.isSymbolicLink() && sub.name.endsWith('.jsonl')) {
            try {
              const subPath = join(subagentsDir, sub.name);
              const subSt = lstatSync(subPath);
              if (subSt.isSymbolicLink()) continue; // skip symlinks
              files.push({
                path: subPath,
                sessionId: basename(sub.name, '.jsonl'),
                mtime: subSt.mtimeMs,
              });
            } catch {
              // Skip entries that can't be stat'd
              continue;
            }
          }
        }
      }
    }
  }

  // Deduplicate: when a session has both a flat and nested transcript,
  // keep only the flat file (the canonical source in newer Claude Code versions).
  // Subagent files (inside subagents/) are kept unconditionally because their
  // paths never match the nested transcript pattern below.
  const nestedSuffix = (sid: string) => join(sid, `${sid}.jsonl`);
  const deduped = files.filter(f => {
    const isNested = f.path.endsWith(nestedSuffix(f.sessionId));
    return !isNested || !flatSessionIds.has(f.sessionId);
  });

  return deduped.sort((a, b) => {
    const mtimeDiff = a.mtime - b.mtime;
    if (mtimeDiff !== 0) return mtimeDiff;
    const sessionIdDiff = a.sessionId.localeCompare(b.sessionId);
    if (sessionIdDiff !== 0) return sessionIdDiff;
    return a.path.localeCompare(b.path);
  });
}

// ---------------------------------------------------------------------------
// Shared inner loop — ingests a flat list of { path, sessionId, cwd } entries
// ---------------------------------------------------------------------------

interface SessionEntry {
  path: string;
  sessionId: string;
  cwd: string;
  client?: "claude" | "codex";
}

type CompactLlmUsage = {
  provider: string;
  model: string;
  calls: number;
  okCalls: number;
  failedCalls: number;
  tokensSpent: number;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  costUsd?: number;
  callsWithCost: number;
};

function accumulateReplayUsage(result: ImportResult, usage: CompactLlmUsage | undefined): void {
  if (!usage || usage.calls <= 0) return;
  if (!result.replayUsage) {
    result.replayUsage = {
      ...usage,
    };
    return;
  }
  if (result.replayUsage.provider !== usage.provider) {
    result.replayUsage.provider = "mixed";
  }
  if (result.replayUsage.model !== usage.model) {
    result.replayUsage.model = "mixed";
  }
  result.replayUsage.calls += usage.calls;
  result.replayUsage.okCalls += usage.okCalls;
  result.replayUsage.failedCalls += usage.failedCalls;
  result.replayUsage.tokensSpent += usage.tokensSpent;
  result.replayUsage.tokensInput += usage.tokensInput;
  result.replayUsage.tokensCached += usage.tokensCached;
  result.replayUsage.tokensOutput += usage.tokensOutput;
  // Absent stays absent: only a reported price contributes to the total.
  if (usage.costUsd !== undefined) {
    result.replayUsage.costUsd = (result.replayUsage.costUsd ?? 0) + usage.costUsd;
  }
  result.replayUsage.callsWithCost += usage.callsWithCost;
}

/**
 * Checks if a session has already been recorded in session_ingest_log,
 * indicating it was fully ingested in a previous run.
 */
function isSessionAlreadyIngested(cwd: string, sessionId: string, lcmDir?: string): boolean {
  try {
    const dbPath = lcmDir
      ? join(lcmDir, "projects", projectId(cwd), "db.sqlite")
      : projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      return false;
    }
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const row = db.prepare("SELECT 1 FROM session_ingest_log WHERE session_id = ?").get(sessionId);
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    // Table may not exist yet or db is inaccessible — proceed with import
    return false;
  }
}

async function ingestSessionList(
  client: DaemonClient,
  sessions: SessionEntry[],
  options: ImportOptions,
  result: ImportResult,
  /**
   * Cwds already cleared by `--restart` in this run. Shared across every call,
   * because a single import can reach the same project from more than one list
   * (per-project Claude dirs, then Codex) and clearing twice would wipe the
   * state the first pass had already started rebuilding.
   */
  clearedCwds: Set<string>,
): Promise<void> {
  // Replay runs are resumable: a manifest freezes the ordering and a ledger
  // records completed compactions, so a restarted run skips finished work.
  // State lives per project DB, keyed by each session's own cwd (a codex/all
  // import can span multiple projects in one list).
  const replayRuns = new Map<string, string>(); // cwd → runId
  const ledgerPositions = new Map<string, Map<string, number>>(); // cwd → (sessionId → position)
  const manifestForNewRun = new Map<string, SessionEntry[]>(); // cwd → sessions to freeze
  let doneCount = 0;
  const previousSummaryByCwd = new Map<string, string | undefined>();

  if (options.replay && !options.dryRun && sessions.length > 0) {
    if (options.restart) {
      // importSessions refuses the whole run up front, but that check can be
      // minutes stale by the time a later list reaches its own clear, so
      // re-check immediately before wiping this list's projects.
      const cwdsToClear = [...new Set(sessions.map((s) => s.cwd))].filter((cwd) => !clearedCwds.has(cwd));
      await refuseRestartDuringCompaction(client, new Set(cwdsToClear));
      let clearFailed = false;
      for (const cwd of cwdsToClear) {
        clearedCwds.add(cwd);
        const ok = await clearReplayState({
          cwd,
          lcmDir: options._lcmDir,
          command: "import",
          onSummaryCount: (count) => {
            if (count > 0) {
              console.error(`  ⚠️ [replay] --restart discards ${count} summaries in ${cwd}; they will be regenerated`);
            }
          },
        });
        if (!ok) clearFailed = true;
      }
      if (clearFailed) {
        console.error("  ⚠️ [replay] could not fully clear previous replay state; some stale summaries may remain");
      }
    }
    const plan = planReplayResume({
      sessions,
      lcmDir: options._lcmDir,
      command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
      restart: options.restart,
    });
    for (const [cwd, sessionIds] of plan.manifests) {
      replayRuns.set(cwd, plan.runIds.get(cwd)!);
      if (plan.freshCwds.has(cwd)) {
        // Fresh project run — freeze the manifest once the loop reaches it.
        const order = new Set(sessionIds);
        manifestForNewRun.set(cwd, sessions.filter((s) => s.cwd === cwd && order.has(s.sessionId)));
      } else {
        const positions = plan.positions.get(cwd);
        if (positions) ledgerPositions.set(cwd, positions);
        const appends = plan.manifestAppends.get(cwd) ?? [];
        if (appends.length > 0) {
          appendReplayManifestSessions({
            cwd,
            lcmDir: options._lcmDir,
            command: "import",
            runId: plan.runIds.get(cwd)!,
            sessions: appends.map((sessionId) => ({
              sessionId,
              position: plan.positions.get(cwd)?.get(sessionId) ?? 0,
            })),
            model: options.replayModel ?? null,
          });
        }
      }
      previousSummaryByCwd.set(cwd, plan.restoredPreviousSummaries.get(cwd));
    }
    sessions = plan.remaining;
    doneCount = plan.doneCount;
    if (plan.freshCwds.size < plan.manifests.size) {
      for (const cwd of plan.droppedPreviousSummaries.keys()) {
        console.error(`  ⚠️ [replay] previous run's chain was broken at the resume point for cwd ${cwd}; continuing without prior context`);
      }
      for (const changed of plan.changedSessionIds) {
        console.error(`  ⚠️ [replay] transcript for session ${changed} changed since the previous run; downstream summaries were threaded against the older version`);
      }
      const resumed: ImportResult["resumed"] = {
        doneCount: plan.doneCount,
        totalCount: plan.doneCount + plan.remaining.length,
        model: plan.previousModel ?? undefined,
      };
      result.resumed = resumed;
      options.onProgress?.({ resumed });
    }
  }
  const total = sessions.length + doneCount;
  const processedBase = doneCount;

  for (const { path, sessionId, cwd, client: sourceClient = "claude" } of sessions) {
    // Stop starting new work after SIGINT/SIGTERM; the renderer waits for the
    // in-flight session to settle before exiting.
    if (options.onBeforeSession && !options.onBeforeSession()) break;

    if (options.dryRun) {
      if (options.verbose) {
        const replayNote = options.replay ? " (would compact)" : "";
        console.log(`  [dry-run] ${sessionId}${replayNote}`);
      }
      result.imported++;
      options.onProgress?.({ completed: result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
      continue;
    }

    // Skip sessions already recorded in session_ingest_log (unless in replay mode,
    // where compaction must still run to keep the temporal chain intact).
    if (!options.replay && isSessionAlreadyIngested(cwd, sessionId, options._lcmDir)) {
      result.skippedEmpty++;
      if (options.verbose) console.log(`  ↩️ ${sessionId}: already fully ingested`);
      options.onProgress?.({ completed: processedBase + result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
      continue;
    }

    const releaseInFlight = options.trackInFlight ? options.trackInFlight() : null;
    try {
      let inputFingerprint = "unavailable";
      if (options.replay) {
        try {
          inputFingerprint = fingerprintFile(path);
        } catch {
          inputFingerprint = "unavailable";
        }
      }
      // Captured before the /compact call below so a timed-out compact only
      // recovers a summary persisted after the call started — a stale one from
      // an earlier run is not mistaken for the in-flight call's result.
      let compactStartedAt = 0;
      const res = await client.post<{ ingested: number; totalTokens: number }>('/ingest', {
        session_id: sessionId,
        cwd,
        transcript_path: path,
        ...(sourceClient === "codex" ? { client: "codex" } : {}),
        // A completed session's transcript may have grown; replay must ingest the tail.
        ...(options.replay ? { replay: true } : {}),
      });
      if (res.ingested === 0 && res.totalTokens === 0) {
        result.skippedEmpty++;
        if (options.verbose) console.log(`  \u23ed\ufe0f ${sessionId}: empty or already ingested`);
      } else {
        result.imported++;
        result.totalMessages += res.ingested;
        // In replay mode, totalTokens is sourced from compact's tokensBefore to avoid
        // double-counting (compact covers already-ingested sessions too).
        if (!options.replay) {
          result.totalTokens += res.totalTokens;
        }
        if (options.verbose) console.log(`  \u2705 ${sessionId}: ${res.ingested} messages (${formatNumber(res.totalTokens)} tokens)`);
      }

      // Replay: compact immediately after every session (even already-ingested ones)
      // so that re-runs are idempotent and the temporal chain stays intact.
      if (options.replay) {
        const pendingManifest = manifestForNewRun.get(cwd);
        if (pendingManifest) {
          // Freeze the manifest once the first ingest has succeeded: a run that
          // dies earlier leaves no resumable state behind, and a first-ever import
          // has no project database until an ingest with content creates it. The
          // manifest stays pending until it is actually written.
          const runId = replayRuns.get(cwd)!;
          const written = createReplayRun({
            cwd,
            lcmDir: options._lcmDir,
            command: "import",
            runId,
            sessions: pendingManifest,
            model: options.replayModel ?? null,
          });
          if (written) {
            const positions = new Map<string, number>();
            pendingManifest.forEach((s, i) => positions.set(s.sessionId, i));
            ledgerPositions.set(cwd, positions);
            manifestForNewRun.delete(cwd);
          }
        }

        try {
          compactStartedAt = Date.now();
          const compactRes = await client.post<{
            summary?: string;
            latestSummaryContent?: string;
            latestSummaryId?: string;
            latestSummaryIds?: string[];
            skipped?: boolean;
            replayOutcome?: "disabled" | "skipped" | "compacted" | "no_work";
            tokensBefore?: number;
            tokensAfter?: number;
            llmUsage?: CompactLlmUsage;
          }>('/compact', {
            session_id: sessionId,
            cwd,
            skip_ingest: true,
            client: sourceClient,
            ...(previousSummaryByCwd.get(cwd) !== undefined ? { previous_summary: previousSummaryByCwd.get(cwd) } : {}),
          });
          const hadPrevious = previousSummaryByCwd.get(cwd) !== undefined;
          if (compactRes.latestSummaryContent !== undefined) {
            previousSummaryByCwd.set(cwd, compactRes.latestSummaryContent);
          }
          // Ledger row is written only after the summary is persisted
          // (latestSummaryId in hand). summaryId=null marks a broken chain
          // link; the session itself is still recorded as done.
          // A skipped (already-in-progress) compaction records nothing — the
          // next run retries it.
          const runId = replayRuns.get(cwd);
          const outcome =
            compactRes.replayOutcome === "compacted" || compactRes.replayOutcome === "no_work"
              ? compactRes.replayOutcome
              : null;
          if (runId !== undefined && outcome) {
            recordReplayProgress({
              cwd,
              lcmDir: options._lcmDir,
              runId,
              sessionId,
              position: ledgerPositions.get(cwd)?.get(sessionId) ?? 0,
              contentFingerprint: inputFingerprint,
              summaryId: compactRes.latestSummaryId ?? null,
              outcome,
              model: options.replayModel ?? null,
            });
          }
          // Use compact's tokensBefore as the authoritative token count for this session.
          // This avoids under-reporting when /ingest returns totalTokens=0 (already-ingested).
          if (typeof compactRes.tokensBefore === 'number') {
            result.totalTokens += compactRes.tokensBefore;
          }
          if (typeof compactRes.tokensAfter === 'number') {
            result.tokensAfter += compactRes.tokensAfter;
          }
          accumulateReplayUsage(result, compactRes.llmUsage);
          if (options.verbose) {
            const ctx = hadPrevious ? ' (with prior context)' : '';
            if (typeof compactRes.tokensBefore === 'number' && typeof compactRes.tokensAfter === 'number' && compactRes.tokensAfter < compactRes.tokensBefore) {
              const ratio = formatRatio(compactRes.tokensBefore, compactRes.tokensAfter);
              console.log(`  \ud83e\udde0 ${sessionId}: ${formatNumber(compactRes.tokensBefore)} \u2192 ${formatNumber(compactRes.tokensAfter)}  (${ratio}\u00d7)${ctx}`);
            } else {
              console.log(`  \ud83e\udde0 ${sessionId}: compacted${ctx}`);
            }
          }
        } catch (err) {
          // Non-fatal: import succeeded. The chain follows what was persisted:
          // when the client merely gave up (timeout/abort) the daemon may have
          // stored the summary anyway, so re-read it; when nothing is stored
          // yet keep the previous link rather than summarising the next session
          // blind. A real daemon failure breaks the chain at this link.
          // Warnings print regardless of --verbose so users know the DAG state.
          const gaveUp = isClientGaveUpError(err);
          const recovered = gaveUp
            ? await loadLatestSessionSummary({ cwd, lcmDir: options._lcmDir, sessionId, notBefore: compactStartedAt })
            : null;
          if (recovered) {
            previousSummaryByCwd.set(cwd, recovered.content);
            const runId = replayRuns.get(cwd);
            if (runId !== undefined) {
              recordReplayProgress({
                cwd,
                lcmDir: options._lcmDir,
                runId,
                sessionId,
                position: ledgerPositions.get(cwd)?.get(sessionId) ?? 0,
                contentFingerprint: inputFingerprint,
                summaryId: recovered.summaryId,
                outcome: "compacted",
                model: options.replayModel ?? null,
              });
            }
            // The ledger records this as compacted, so the run summary must
            // count its tokens too — otherwise ledger and summary disagree.
            // sourceMessageTokenCount can be 0 (e.g. missing links/backfill
            // results); fall back to the ingest's totalTokens so tokens aren't
            // silently dropped from the run total.
            result.totalTokens += recovered.sourceMessageTokenCount > 0 ? recovered.sourceMessageTokenCount : res.totalTokens;
            result.tokensAfter += recovered.contextTokenCount;
            console.error(`  \u26a0\ufe0f [replay] compact call gave up for session ${sessionId} (${err instanceof Error ? err.message : 'unknown error'}) but its summary was stored; chain continues`);
          } else if (gaveUp) {
            console.error(`  \u26a0\ufe0f [replay] compact call gave up for session ${sessionId} (${err instanceof Error ? err.message : 'unknown error'}) and no summary was found; chain skips this session`);
          } else {
            previousSummaryByCwd.set(cwd, undefined);
            console.error(`  \u26a0\ufe0f [replay] compact failed for session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
          }
          if (err instanceof Error) {
            const llmUsage = (err as Error & { body?: { llmUsage?: CompactLlmUsage } }).body?.llmUsage;
            accumulateReplayUsage(result, llmUsage);
          }
          // Fall back to ingest's totalTokens so they aren't silently lost —
          // unless the recovered summary already accounted for the session.
          if (!recovered) {
            result.totalTokens += res.totalTokens;
          }
        }
      }
      options.onProgress?.({ completed: processedBase + result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
    } catch (err) {
      result.failed++;
      if (options.replay) {
        previousSummaryByCwd.set(cwd, undefined); // chain broken by ingest failure
      }
      if (options.verbose) console.log(`  \u274c ${sessionId}: ${err instanceof Error ? err.message : "failed"}`);
      options.onProgress?.({ completed: processedBase + result.imported + result.skippedEmpty + result.failed, total, current: { sessionId, messages: 0, tokens: 0, startedAt: Date.now() } });
    } finally {
      releaseInFlight?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function importSessions(
  client: DaemonClient,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const provider: ImportProvider = options.provider ?? "claude";
  const result: ImportResult = { imported: 0, skippedEmpty: 0, failed: 0, totalMessages: 0, totalTokens: 0, tokensAfter: 0 };
  // One --restart clear per project for the whole import, however many session
  // lists reach that project.
  const clearedCwds = new Set<string>();

  // --- Session lists, in import order: every Claude project dir, then every Codex project ---
  const sessionLists: SessionEntry[][] = [];

  if (provider === "claude" || provider === "all") {
    const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), '.claude', 'projects');

    const projectDirs: { dir: string; cwd: string }[] = [];

    if (options.all) {
      if (existsSync(claudeProjectsDir)) {
        const projectMap = buildProjectMap(options._lcmDir);
        for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cwd = projectMap.get(entry.name);
          if (!cwd) continue;
          projectDirs.push({ dir: join(claudeProjectsDir, entry.name), cwd });
        }
      }
    } else {
      const cwd = options.cwd ?? process.cwd();
      const hash = cwdToProjectHash(cwd);
      const dir = join(claudeProjectsDir, hash);
      if (existsSync(dir)) {
        projectDirs.push({ dir, cwd });
      }
    }

    for (const { dir, cwd } of projectDirs) {
      sessionLists.push(findSessionFiles(dir).map(f => ({ ...f, cwd })));
    }
  }

  if (provider === "codex" || provider === "all") {
    const codexTranscripts = findAllCodexTranscripts(options._codexDir);
    const targetProject = projectId(options.cwd ?? process.cwd());
    const projects = new Map<string, SessionEntry[]>();
    for (const transcript of codexTranscripts) {
      // Unknown provenance must not be assigned to the invoking project.
      if (!transcript.cwd) continue;
      const id = projectId(transcript.cwd);
      if (!options.all && id !== targetProject) continue;
      const sessions = projects.get(id) ?? [];
      sessions.push({ ...transcript, cwd: transcript.cwd, client: "codex" });
      projects.set(id, sessions);
    }
    // Keep replay context inside one project when importing all projects.
    sessionLists.push(...projects.values());
  }

  // A `replay && restart` refusal must happen before any wipe: with
  // `provider all`, refusing only when a later list runs would leave earlier
  // lists already wiped and regenerated, and a retry would re-wipe them.
  // Check every project the import will touch first (batch-compact does the
  // same for its single pass over all projects).
  if (options.replay && options.restart && !options.dryRun) {
    await refuseRestartDuringCompaction(client, new Set(sessionLists.flat().map((s) => s.cwd)));
  }

  for (const sessions of sessionLists) {
    await ingestSessionList(client, sessions, options, result, clearedCwds);
  }

  return result;
}
