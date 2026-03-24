import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { DaemonClient } from "./daemon/client.js";
import { formatNumber, formatRatio } from "./stats.js";
import { findAllCodexTranscripts, extractCodexSessionCwd } from "./codex-transcript.js";
import type { ProgressState } from "./cli/progress-state.js";
import { projectDbPath } from "./daemon/project.js";

export type ImportProvider = "claude" | "codex" | "all";

interface ImportOptions {
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  replay?: boolean;
  /** Which transcript provider to import from (default: "claude") */
  provider?: ImportProvider;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
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
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const sessionId = basename(entry.name, '.jsonl');
        files.push({
          path: join(projectDir, entry.name),
          sessionId,
          mtime: statSync(join(projectDir, entry.name)).mtimeMs,
        });
        flatSessionIds.add(sessionId);
      } catch {
        // Skip entries that can't be stat'd (file deleted or permissions issue)
        continue;
      }
    }
    if (entry.isDirectory()) {
      // Layout A (nested): <projectDir>/<session-id>/<session-id>.jsonl
      const nestedTranscript = join(projectDir, entry.name, `${entry.name}.jsonl`);
      if (existsSync(nestedTranscript)) {
        try {
          const nestedStat = statSync(nestedTranscript);
          if (nestedStat.isFile()) {
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
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            try {
              files.push({
                path: join(subagentsDir, sub.name),
                sessionId: basename(sub.name, '.jsonl'),
                mtime: statSync(join(subagentsDir, sub.name)).mtimeMs,
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
}

/**
 * Checks if a session has already been recorded in session_ingest_log,
 * indicating it was fully ingested in a previous run.
 */
function isSessionAlreadyIngested(cwd: string, sessionId: string, lcmDir?: string): boolean {
  try {
    const dbPath = lcmDir
      ? join(lcmDir, "projects", cwdToProjectHash(cwd), "project.db")
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
): Promise<void> {
  let previousSummary: string | undefined;

  for (const { path, sessionId, cwd } of sessions) {
    if (options.dryRun) {
      if (options.verbose) {
        const replayNote = options.replay ? " (would compact)" : "";
        console.log(`  [dry-run] ${sessionId}${replayNote}`);
      }
      result.imported++;
      continue;
    }

    // Skip sessions already recorded in session_ingest_log
    if (isSessionAlreadyIngested(cwd, sessionId, options._lcmDir)) {
      result.skippedEmpty++;
      if (options.verbose) console.log(`  ↩️ ${sessionId}: already fully ingested`);
      continue;
    }

    try {
      const res = await client.post<{ ingested: number; totalTokens: number }>('/ingest', {
        session_id: sessionId,
        cwd,
        transcript_path: path,
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
        try {
          const compactRes = await client.post<{
            summary?: string;
            latestSummaryContent?: string;
            skipped?: boolean;
            tokensBefore?: number;
            tokensAfter?: number;
          }>('/compact', {
            session_id: sessionId,
            cwd,
            skip_ingest: true,
            client: 'claude',
            ...(previousSummary !== undefined ? { previous_summary: previousSummary } : {}),
          });
          const hadPrevious = previousSummary !== undefined;
          if (compactRes.latestSummaryContent !== undefined) {
            previousSummary = compactRes.latestSummaryContent;
          }
          // Use compact's tokensBefore as the authoritative token count for this session.
          // This avoids under-reporting when /ingest returns totalTokens=0 (already-ingested).
          if (typeof compactRes.tokensBefore === 'number') {
            result.totalTokens += compactRes.tokensBefore;
          }
          if (typeof compactRes.tokensAfter === 'number') {
            result.tokensAfter += compactRes.tokensAfter;
          }
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
          // Non-fatal: import succeeded; compact failure breaks the chain at this link.
          previousSummary = undefined;
          // Always warn on chain breakage so users know the DAG is incomplete,
          // regardless of whether --verbose was passed.
          console.error(`  \u26a0\ufe0f [replay] compact failed for session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
          // Fall back to ingest's totalTokens so they aren't silently lost.
          result.totalTokens += res.totalTokens;
        }
      }
    } catch (err) {
      result.failed++;
      if (options.replay) previousSummary = undefined; // chain broken by ingest failure
      if (options.verbose) console.log(`  \u274c ${sessionId}: ${err instanceof Error ? err.message : "failed"}`);
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
  const onProgress = options.onProgress;
  const progressErrors: { sessionId: string; message: string }[] = [];

  // --- Claude Code sessions ---
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
      const sessionFiles = findSessionFiles(dir);
      await ingestSessionList(
        client,
        sessionFiles.map(f => ({ ...f, cwd })),
        options,
        result,
      );
    }
  }

  // --- Codex CLI sessions ---
  if (provider === "codex" || provider === "all") {
    const codexTranscripts = findAllCodexTranscripts(options._codexDir);
    const codexSessions: SessionEntry[] = codexTranscripts.map(f => ({
      path: f.path,
      sessionId: f.sessionId,
      // Prefer the cwd embedded in the transcript; fall back to process.cwd()
      cwd: extractCodexSessionCwd(f.path) ?? process.cwd(),
    }));

    await ingestSessionList(client, codexSessions, options, result);
  }

  return result;
}
