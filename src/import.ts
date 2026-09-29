import { readdirSync, existsSync, lstatSync, type Dirent } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DaemonClient } from "./daemon/client.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
import { formatNumber, formatRatio } from "./stats.js";
import { findAllCodexTranscripts } from "./codex-transcript.js";
import { findAllOmpTranscripts, ompDiscoveryRoots } from "./omp-transcript.js";
import type { ProgressState } from "./cli/progress-state.js";
import { claudeProjectSlug, projectDbPath, projectDir, projectId } from "./daemon/project.js";
import { readProjectMetaIn } from "./daemon/project-meta.js";
import { createLcmPaths, type LcmPaths } from "./lcm-paths.js";
import { discoverSubagentTranscripts, type SubagentAttribution } from "./subagent-attribution.js";
import { isSessionComplete } from "./capture.js";
import { claudeRebuildCandidateIds, planSessionRebuild, type SessionRebuildPlan } from "./claude-rebuild.js";
import { planCutRowRepair, type CutRepairClient, type CutRowRepairPlan } from "./cut-row-repair.js";
import { ScrubEngine } from "./scrub.js";
import { parseTranscript } from "./transcript.js";
import {
  appendReplayManifestSessions,
  clearReplayState,
  createReplayRun,
  fingerprintFile,
  isClientGaveUpError,
  isConnectionDroppedError,
  isDaemonUnreachableError,
  loadLatestSessionSummary,
  planReplayResume,
  recordReplayProgress,
} from "./replay-resume.js";

export type ImportProvider = "claude" | "codex" | "omp" | "all";

const IMPORT_PROVIDERS: readonly ImportProvider[] = ["claude", "codex", "omp", "all"];

/** The transcript-source flags `lcm import` accepts: `--provider <name>` and its aliases `--codex` and `--omp`. */
export type ImportProviderFlags = { provider?: string; codex?: boolean; omp?: boolean };

/**
 * The one place that decides which transcript sources an import reads. No flag means every
 * source (`all`); `--codex` and `--omp` are aliases for `--provider codex|omp`. Throws with a
 * user-facing message when the flags conflict or name an unknown source.
 */
export function resolveImportProvider(flags: ImportProviderFlags = {}): ImportProvider {
  if (flags.codex && flags.omp) throw new Error("--codex cannot be combined with --omp");
  const alias: ImportProvider | undefined = flags.codex ? "codex" : flags.omp ? "omp" : undefined;
  const named = flags.provider;
  if (named !== undefined && !IMPORT_PROVIDERS.includes(named as ImportProvider)) {
    throw new Error(`Unknown provider "${named}". Use: ${IMPORT_PROVIDERS.join(", ")}`);
  }
  if (alias && named !== undefined && named !== alias) {
    throw new Error(`--${alias} cannot be combined with a different --provider`);
  }
  return alias ?? (named as ImportProvider | undefined) ?? "all";
}

interface ImportOptions {
  paths?: LcmPaths;
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  replay?: boolean;
  /** Replay only: discard recorded progress and start from scratch */
  restart?: boolean;
  /** Replay only: model label recorded in the ledger (shown on resume) */
  replayModel?: string;
  /** Which transcript provider to import from; resolved by `resolveImportProvider` (default: "all") */
  provider?: ImportProvider;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
  /** Called before each session starts; return false to stop the run (e.g. after SIGINT/SIGTERM) */
  onBeforeSession?: () => boolean;
  /** Wrap an in-flight session's work so signal handlers can wait for it before exiting */
  trackInFlight?: () => () => void;
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
  /** Explicit storage root used by older library callers. */
  _lcmDir?: string;
  /** Override ~/.codex path — used in tests only */
  _codexDir?: string;
  /** Override ~/.omp/agent path — used in tests only */
  _ompDir?: string;
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
  /** Present for an explicit `--provider omp`/`--omp` run: every OMP sessions root discovery scanned, in scan order. */
  ompRootsScanned?: string[];
  /** Present when two OMP roots hold the same session id: each transcript not imported because another root's copy was chosen. */
  ompDuplicatesSkipped?: string[];
  /** Set when the daemon refused a connection outright; the run stopped instead of failing every remaining session. Rerun the same command to resume. */
  daemonUnreachable?: boolean;
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


function buildProjectMap(paths: LcmPaths): Map<string, string> {
  const lcmProjectsDir = paths.projectsDir;
  const map = new Map<string, string>();
  if (!existsSync(lcmProjectsDir)) return map;
  for (const entry of readdirSync(lcmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cwd = readProjectMetaIn(join(lcmProjectsDir, entry.name))?.cwd;
    if (cwd) map.set(claudeProjectSlug(cwd), cwd);
  }
  return map;
}

export interface DiscoveredSessionFile {
  path: string;
  sessionId: string;
  mtime: number;
  /** Subagent transcripts only — carried from the `.meta.json` sidecar. Absent for ordinary sessions. */
  attribution?: SubagentAttribution;
}

function findFlatSessionFile(projectDir: string, entry: Dirent): DiscoveredSessionFile | null {
  if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) return null;
  try {
    const filePath = join(projectDir, entry.name);
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) return null; // skip symlinks
    return { path: filePath, sessionId: basename(entry.name, '.jsonl'), mtime: st.mtimeMs };
  } catch {
    return null; // file deleted or permissions issue
  }
}

function findNestedSessionFile(projectDir: string, sessionDirName: string): DiscoveredSessionFile | null {
  // Layout A (nested): <projectDir>/<session-id>/<session-id>.jsonl
  const nestedTranscript = join(projectDir, sessionDirName, `${sessionDirName}.jsonl`);
  if (!existsSync(nestedTranscript)) return null;
  try {
    const nestedStat = lstatSync(nestedTranscript);
    if (nestedStat.isSymbolicLink() || !nestedStat.isFile()) return null;
    return { path: nestedTranscript, sessionId: sessionDirName, mtime: nestedStat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Subagent transcripts: <projectDir>/<session-id>/subagents/<...>/<agent-id>.jsonl,
 * found by the one walker in src/subagent-attribution.ts so `lcm import`
 * discovers exactly what live `/ingest` does. The attribution travels with
 * the file — nothing is re-derived from the path later.
 */
function findSubagentSessionFiles(projectDir: string, sessionDirName: string): DiscoveredSessionFile[] {
  return discoverSubagentTranscripts(join(projectDir, sessionDirName));
}

export function findSessionFiles(projectDir: string): DiscoveredSessionFile[] {
  const files: DiscoveredSessionFile[] = [];
  if (!existsSync(projectDir)) return files;

  // Track which session IDs have a flat (project-root) transcript so we can
  // deduplicate when the same session also has a nested copy.
  const flatSessionIds = new Set<string>();

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    const flat = findFlatSessionFile(projectDir, entry);
    if (flat) {
      files.push(flat);
      flatSessionIds.add(flat.sessionId);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

    const nested = findNestedSessionFile(projectDir, entry.name);
    if (nested) files.push(nested);
    files.push(...findSubagentSessionFiles(projectDir, entry.name));
  }

  // Deduplicate: when a session has both a flat and nested transcript,
  // keep only the flat file (the canonical source in newer Claude Code versions).
  // A subagent file at `<session>/subagents/<X>/<X>.jsonl` does match the
  // nested pattern below (sessionId X, path ending in X/X.jsonl) and would be
  // dropped if a flat `<project>/<X>.jsonl` also existed — Claude Code does
  // not write that layout today, so this is a theoretical false-positive
  // risk, not a pattern mismatch.

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
  client?: "claude" | "codex" | "omp";
  /** Subagent sessions only — see DiscoveredSessionFile. */
  attribution?: SubagentAttribution;
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
 * indicating it was fully ingested in a previous run, and its transcript
 * was not written to since.
 */
function isSessionAlreadyIngested(cwd: string, sessionId: string, transcriptPath: string, paths: LcmPaths): boolean {
  try {
    const dbPath = projectDbPath(cwd, paths);
    if (!existsSync(dbPath)) {
      return false;
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return isSessionComplete(db, sessionId, transcriptPath);
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
      const cwdsToClear = [...new Set(sessions.map((s) => s.cwd))].filter((cwd) => !clearedCwds.has(cwd));
      let clearFailed = false;
      for (const cwd of cwdsToClear) {
        clearedCwds.add(cwd);
        const ok = await clearReplayState({
          cwd,
          paths: options.paths,
          command: "import",
          client,
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
      paths: options.paths,
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
            paths: options.paths,
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

  for (const { path, sessionId, cwd, client: sourceClient = "claude", attribution } of sessions) {
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

    // Claude's adapter cannot recover a tail, so a completed Claude session whose transcript
    // has not changed since can skip /ingest; a resume appends to the same file.
    // Codex and OMP may have a final record deferred by live capture and must reach /ingest.
    if (!options.replay && sourceClient === "claude" && options.paths && isSessionAlreadyIngested(cwd, sessionId, path, options.paths)) {
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
        source: "import",
        ...(sourceClient !== "claude" ? { client: sourceClient } : {}),
        // A completed session's transcript may have grown; replay must ingest the tail.
        ...(options.replay ? { replay: true } : {}),
        // Subagent attribution, carried from the sidecar findSessionFiles already read.
        ...(attribution?.parentSessionId ? { parent_session_id: attribution.parentSessionId } : {}),
        ...(attribution?.subagentType ? { subagent_type: attribution.subagentType } : {}),
        ...(attribution?.subagentDesc ? { subagent_desc: attribution.subagentDesc } : {}),
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
            paths: options.paths,
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
              paths: options.paths,
              runId,
              sessionId,
              position: ledgerPositions.get(cwd)?.get(sessionId) ?? 0,
              contentFingerprint: inputFingerprint,
              summaryId: compactRes.latestSummaryId ?? null,
              outcome,
              // The model whose answer was stored; a fallback may have replaced the configured one.
              model: compactRes.llmUsage?.model || options.replayModel || null,
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
          if (isDaemonUnreachableError(err)) {
            // The daemon is gone, not just this session's compaction: every
            // later call would fail identically, so the run stops here
            // instead of marking the rest failed and breaking their chain.
            // Stopping (rather than an in-process retry loop) is the simpler
            // correct move, since replay runs are already resumable — a plain
            // rerun picks up exactly where this one stopped.
            console.error(
              `  ⚠️ the daemon is unreachable (${err instanceof Error ? err.message : "unknown error"}); ` +
              `stopping instead of failing every remaining session. Rerun the same \`lcm import\` command to resume where this run left off.`,
            );
            result.daemonUnreachable = true;
            break;
          }
          if (isConnectionDroppedError(err) && !(await client.health())) {
            // A mid-flight socket drop is ambiguous on its own: the daemon
            // may have just died, or it may be alive but wedged (its event
            // loop blocked on a slow query, say) and RSTing every request it
            // cannot service, /health included. The probe resolves that — no
            // answer means treat it exactly like a refused connection.
            console.error(
              `  ⚠️ the daemon is not answering — down or unresponsive (${err instanceof Error ? err.message : "unknown error"}); ` +
              `stopping instead of failing every remaining session. Rerun the same \`lcm import\` command to resume where this run left off.`,
            );
            result.daemonUnreachable = true;
            break;
          }
          // Non-fatal: import succeeded. The chain follows what was persisted:
          // when the client merely gave up (timeout/abort) the daemon may have
          // stored the summary anyway, so re-read it; when nothing is stored
          // yet keep the previous link rather than summarising the next session
          // blind. A real daemon failure breaks the chain at this link.
          // Warnings print regardless of --verbose so users know the DAG state.
          const gaveUp = isClientGaveUpError(err);
          const recovered = gaveUp
            ? await loadLatestSessionSummary({ cwd, paths: options.paths, sessionId, notBefore: compactStartedAt })
            : null;
          if (recovered) {
            previousSummaryByCwd.set(cwd, recovered.content);
            const runId = replayRuns.get(cwd);
            if (runId !== undefined) {
              recordReplayProgress({
                cwd,
                paths: options.paths,
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
      if (isDaemonUnreachableError(err)) {
        // Same stop as the /compact case below: the daemon itself is gone,
        // so every remaining session (including its /ingest call) would fail
        // identically. Stop instead of counting the rest as failed.
        console.error(
          `  \u26a0\ufe0f the daemon is unreachable (${err instanceof Error ? err.message : "unknown error"}); ` +
          `stopping instead of failing every remaining session. Rerun the same \`lcm import\` command to resume where this run left off.`,
        );
        result.daemonUnreachable = true;
        break;
      }
      if (isConnectionDroppedError(err) && !(await client.health())) {
        console.error(
          `  ⚠️ the daemon is not answering — down or unresponsive (${err instanceof Error ? err.message : "unknown error"}); ` +
          `stopping instead of failing every remaining session. Rerun the same \`lcm import\` command to resume where this run left off.`,
        );
        result.daemonUnreachable = true;
        break;
      }
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
  options: ImportOptions,
): Promise<ImportResult> {
  const paths = options.paths ?? (options._lcmDir ? createLcmPaths(options._lcmDir) : undefined);
  if (paths) options.paths = paths;
  const provider = resolveImportProvider({ provider: options.provider });
  const result: ImportResult = { imported: 0, skippedEmpty: 0, failed: 0, totalMessages: 0, totalTokens: 0, tokensAfter: 0 };
  // One --restart clear per project for the whole import, however many session
  // lists reach that project.
  const clearedCwds = new Set<string>();

  // --- Session lists, in import order: every Claude project dir, then Codex and OMP ---
  const sessionLists: SessionEntry[][] = [];

  if (provider === "claude" || provider === "all") {
    const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), '.claude', 'projects');

    const projectDirs: { dir: string; cwd: string }[] = [];

    if (options.all) {
      if (existsSync(claudeProjectsDir)) {
        if (!paths) throw new Error("importSessions --all requires an LcmPaths storage root");
        const projectMap = buildProjectMap(paths);
        for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cwd = projectMap.get(entry.name);
          if (!cwd) continue;
          projectDirs.push({ dir: join(claudeProjectsDir, entry.name), cwd });
        }
      }
    } else {
      const cwd = options.cwd ?? process.cwd();
      const dir = join(claudeProjectsDir, claudeProjectSlug(cwd));
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

  if (provider === "omp" || provider === "all") {
    // Reported only for an explicit `--provider omp`/`--omp` run: that is the
    // scenario the issue names ("0 sessions" with no clue where discovery
    // looked). A default `all` run would show this for every user regardless
    // of whether they use OMP at all.
    if (provider === "omp") result.ompRootsScanned = ompDiscoveryRoots(options._ompDir);
    // Reported for any provider: it is non-empty only when two OMP roots
    // actually hold the same session id, so it is never noise for a non-OMP user.
    const ompDuplicatesSkipped: string[] = [];
    const ompTranscripts = findAllOmpTranscripts(options._ompDir, (skipped) => ompDuplicatesSkipped.push(skipped.path));
    if (ompDuplicatesSkipped.length > 0) result.ompDuplicatesSkipped = ompDuplicatesSkipped;
    const targetProject = projectId(options.cwd ?? process.cwd());
    const projects = new Map<string, SessionEntry[]>();
    for (const transcript of ompTranscripts) {
      // Unknown provenance must not be assigned to the invoking project.
      if (!transcript.cwd) continue;
      const id = projectId(transcript.cwd);
      if (!options.all && id !== targetProject) continue;
      const sessions = projects.get(id) ?? [];
      sessions.push({ ...transcript, cwd: transcript.cwd, client: "omp" });
      projects.set(id, sessions);
    }
    // Keep replay context inside one project when importing all projects.
    sessionLists.push(...projects.values());
  }

  for (const sessions of sessionLists) {
    await ingestSessionList(client, sessions, options, result, clearedCwds);
    if (result.daemonUnreachable) break;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rebuild: `lcm import --provider claude --rebuild`
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  paths: LcmPaths;
  /** Every tracked project instead of the current one. */
  all?: boolean;
  cwd?: string;
  /** Only this session. */
  sessionId?: string;
  /** Rebuild the repairable sessions through the daemon; without it nothing is written. */
  apply?: boolean;
  /** The configured global redaction patterns, applied like capture applies them. */
  sensitivePatterns?: string[];
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
}

export interface RebuildSessionReport {
  cwd: string;
  plan: SessionRebuildPlan;
  transcriptPath?: string;
  /** Set when `apply` rebuilt it. */
  rebuilt?: boolean;
  /** Messages captured from the transcript by the rebuild. */
  ingested?: number;
  error?: string;
}

export interface RebuildRunResult {
  sessions: RebuildSessionReport[];
  /** One backup per project a rebuild ran in. */
  backups: string[];
  removedBackups?: string[];
  /** Projects that could not be read, or whose backup failed so nothing in them was rebuilt. */
  failedProjects: Array<{ cwd: string; error: string }>;
}

/**
 * Classifies Claude Code sessions with compaction events or an unknown parser shape, per project, from the project
 * database opened read-only and the session's transcript — no daemon. With `apply`, sends each
 * repairable session to the daemon's `/ingest` as a rebuild, asking for a backup of the project
 * database with the first one; a project whose backup fails is left untouched.
 */
export async function rebuildClaudeSessions(client: DaemonClient | undefined, options: RebuildOptions): Promise<RebuildRunResult> {
  const result: RebuildRunResult = { sessions: [], backups: [], removedBackups: [], failedProjects: [] };
  const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const cwds = options.all ? [...new Set(buildProjectMap(options.paths).values())] : [options.cwd ?? process.cwd()];
  for (const cwd of cwds) {
    let reports: RebuildSessionReport[];
    try {
      reports = await classifyProjectSessions(cwd, join(claudeProjectsDir, claudeProjectSlug(cwd)), options);
    } catch (err) {
      result.failedProjects.push({ cwd, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.sessions.push(...reports);
    if (options.apply && client) await applyProjectRebuild(client, cwd, reports, result);
  }
  return result;
}

async function classifyProjectSessions(cwd: string, claudeDir: string, options: RebuildOptions): Promise<RebuildSessionReport[]> {
  const dbPath = projectDbPath(cwd, options.paths);
  if (!existsSync(dbPath)) return [];
  const transcripts = new Map(findSessionFiles(claudeDir).map((file) => [file.sessionId, file.path]));
  const scrubber = await ScrubEngine.forProject(options.sensitivePatterns ?? [], projectDir(cwd, options.paths));
  const scrub = (text: string) => scrubber.scrubWithCounts(text).text;
  const db = getLcmConnection(dbPath, { readOnly: true });
  try {
    const reports: RebuildSessionReport[] = [];
    for (const sessionId of claudeRebuildCandidateIds(db)) {
      if (options.sessionId !== undefined && sessionId !== options.sessionId) continue;
      const transcriptPath = transcripts.get(sessionId);
      const plan = await planSessionRebuild(
        db, sessionId, transcriptPath ? parseTranscript(transcriptPath) : undefined, scrub,
        () => transcriptPath ? parseTranscript(transcriptPath, "legacy") : undefined,
      );
      reports.push({ cwd, plan, transcriptPath });
    }
    return reports;
  } finally {
    closeLcmConnection(dbPath, { readOnly: true });
  }
}

async function applyProjectRebuild(client: DaemonClient, cwd: string, reports: RebuildSessionReport[], result: RebuildRunResult): Promise<void> {
  let backupPath: string | undefined;
  for (const report of reports) {
    if (report.plan.kind !== "repairable") continue;
    try {
      const res = await client.post<{ ingested: number; rebuild: SessionRebuildPlan; backupPath?: string; removedBackups?: string[] }>("/ingest", {
        session_id: report.plan.sessionId, cwd, transcript_path: report.transcriptPath, source: "import", rebuild: true,
        ...(backupPath ? {} : { backup: true }),
      });
      if (res.backupPath) result.backups.push(backupPath = res.backupPath);
      result.removedBackups?.push(...(res.removedBackups ?? []));
      // The daemon classifies again under the project lease; a session that changed since the preview is reported as it found it.
      report.plan = res.rebuild;
      report.rebuilt = res.rebuild.kind === "repairable";
      report.ingested = res.ingested;
    } catch (err) {
      const body = (err as { body?: { backupPath?: unknown; removedBackups?: string[] } }).body;
      const recorded = body?.backupPath;
      result.removedBackups?.push(...(body?.removedBackups ?? []));
      if (typeof recorded === "string" && !backupPath) result.backups.push(backupPath = recorded);
      report.error = err instanceof Error ? err.message : String(err);
      if (!backupPath) {
        result.failedProjects.push({ cwd, error: report.error });
        return;
      }
    }
  }
}

export interface CutRepairRunResult {
  sessions: Array<{ cwd: string; transcriptPath: string; plan: CutRowRepairPlan; repaired?: number; backupPath?: string; removedBackups?: string[]; error?: string }>;
  failedProjects: Array<{ cwd: string; error: string }>;
}

/** Preview locally; with --yes the daemon rechecks each plan under the project lease before writing. */
export async function repairCutRows(
  client: DaemonClient | undefined,
  options: RebuildOptions & { provider: CutRepairClient; _codexDir?: string; _ompDir?: string },
): Promise<CutRepairRunResult> {
  const result: CutRepairRunResult = { sessions: [], failedProjects: [] };
  const target = projectId(options.cwd ?? process.cwd());
  const files = options.provider === "codex"
    ? findAllCodexTranscripts(options._codexDir)
    : findAllOmpTranscripts(options._ompDir);
  const scrubbers = new Map<string, ScrubEngine>();
  const backedUp = new Set<string>();
  const backupFailed = new Set<string>();
  for (const file of files) {
    if (!file.cwd || (!options.all && projectId(file.cwd) !== target)) continue;
    if (options.sessionId !== undefined && file.sessionId !== options.sessionId) continue;
    const cwd = file.cwd;
    const dbPath = projectDbPath(cwd, options.paths);
    if (!existsSync(dbPath)) continue;
    try {
      let scrubber = scrubbers.get(cwd);
      if (!scrubber) {
        scrubber = await ScrubEngine.forProject(options.sensitivePatterns ?? [], projectDir(cwd, options.paths));
        scrubbers.set(cwd, scrubber);
      }
      const db = getLcmConnection(dbPath, { readOnly: true });
      let plan: CutRowRepairPlan;
      try {
        plan = await planCutRowRepair(db, {
          sessionId: file.sessionId, cwd, client: options.provider, transcriptPath: file.path,
          scrub: (text) => scrubber!.scrubWithCounts(text).text,
        });
      } finally {
        closeLcmConnection(dbPath, { readOnly: true });
      }
      const report: CutRepairRunResult["sessions"][number] = { cwd, transcriptPath: file.path, plan };
      result.sessions.push(report);
      if (options.apply && client && plan.kind === "repairable" && !backupFailed.has(dbPath)) {
        try {
          // The first repair a project applies backs its database up; later ones rely on that copy.
          const applied = await client.post<{ repair: CutRowRepairPlan; repaired: number; backupPath?: string; removedBackups?: string[] }>("/ingest", {
            session_id: file.sessionId, cwd, transcript_path: file.path, source: "import", client: options.provider, rebuild: true,
            ...(backedUp.has(dbPath) ? {} : { backup: true }),
          });
          report.plan = applied.repair;
          report.repaired = applied.repaired;
          report.backupPath = applied.backupPath;
          report.removedBackups = applied.removedBackups;
          if (applied.backupPath) backedUp.add(dbPath);
        } catch (error) {
          report.error = error instanceof Error ? error.message : String(error);
          if (!backedUp.has(dbPath) && report.error.includes("backup failed")) {
            backupFailed.add(dbPath);
            result.failedProjects.push({ cwd, error: report.error });
          }
        }
      }
    } catch (error) {
      result.failedProjects.push({ cwd, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
