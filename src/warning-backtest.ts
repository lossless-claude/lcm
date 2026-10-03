import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "./daemon/project.js";
import { formatEnvironmentRule } from "./daemon/restore/insights.js";
import type { LcmPaths } from "./lcm-paths.js";
import { BATCH_SIZE, ENVIRONMENT_SESSION_THRESHOLD } from "./promotion/tool-lesson-projection.js";
import { CALL_SELECT, callShape, type StoredCall } from "./promotion/tool-lessons.js";
import { SHELL_TOOLS } from "./tool-calls.js";
import { estimateTokens } from "./transcript.js";

export interface WarningBacktestReport {
  status: "no-data" | "unavailable" | "measured";
  calls: number;
  shapedCalls: number;
  matches: number;
  resolvedMatches: number;
  matchedFailures: number;
  unmatchedFailures: number;
  unshapedFailures: number;
  excludedOutcomes: { unknown: number; denied: number; interrupted: number };
  precision: number | null;
  coverage: number | null;
  contextCost: {
    sessions: number;
    totalBytes: number; totalTokens: number;
    averageBytes: number; averageTokens: number;
    maxBytes: number; maxTokens: number;
  };
}

function emptyReport(): WarningBacktestReport {
  return { status: "no-data", calls: 0, shapedCalls: 0, matches: 0,
    resolvedMatches: 0, matchedFailures: 0, unmatchedFailures: 0, unshapedFailures: 0,
    excludedOutcomes: { unknown: 0, denied: 0, interrupted: 0 }, precision: null, coverage: null,
    contextCost: { sessions: 0, totalBytes: 0, totalTokens: 0, averageBytes: 0, averageTokens: 0, maxBytes: 0, maxTokens: 0 } };
}

/** One ordered cursor, consumed in bounded pages; no repeated sort or OFFSET scan. CLI only. */
function* callPages(db: DatabaseSync): Generator<StoredCall[]> {
  const rows = db.prepare(CALL_SELECT + `
    WHERE NOT EXISTS (SELECT 1 FROM summarize_workers w WHERE w.session_id = t.session_id)
    ORDER BY seen, t.message_id, t.rowid`).iterate();
  try {
    let page: StoredCall[] = [];
    for (const row of rows) {
      page.push(row as unknown as StoredCall);
      if (page.length === BATCH_SIZE) {
        yield page;
        page = [];
      }
    }
    if (page.length) yield page;
  } finally { rows.return?.(); }
}

/** Replay evidence strictly before each call, without reading or publishing lesson snapshots. */
export function backtestWarnings(db: DatabaseSync): WarningBacktestReport {
  const report = emptyReport();
  const shapes = new Map<string, { sessionCount: number; lastSeen: string; retired: boolean }>();
  // An empty SQLite filename creates a private temporary disk database, deleted on close.
  // Exact session membership and costs must not grow the in-memory per-shape state.
  const scratch = new DatabaseSync("");
  try {
    scratch.exec(`PRAGMA cache_size = -1024; PRAGMA temp_store = FILE; PRAGMA journal_mode = OFF;
      CREATE TABLE failure_sessions (shape TEXT, session_id TEXT, PRIMARY KEY (shape, session_id)) WITHOUT ROWID;
      CREATE TABLE costs (session_id TEXT PRIMARY KEY, bytes INTEGER, tokens INTEGER) WITHOUT ROWID;`);
    const failureSession = scratch.prepare("INSERT OR IGNORE INTO failure_sessions VALUES (?, ?)");
    const cost = scratch.prepare(`INSERT INTO costs VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET bytes = bytes + excluded.bytes, tokens = tokens + excluded.tokens`);

    for (const page of callPages(db)) {
      scratch.exec("BEGIN");
      for (const call of page) {
        report.calls++;
        const failed = call.outcome === "failed" || call.outcome === "blocked";
        const shape = callShape(call);
        if (!shape) {
          if (failed && SHELL_TOOLS.includes(call.name.replace(/^functions\./, "").toLowerCase())) report.unshapedFailures++;
          continue;
        }
        report.shapedCalls++;
        let state = shapes.get(shape);
        const matched = state && !state.retired && state.sessionCount >= ENVIRONMENT_SESSION_THRESHOLD;
        if (state && matched) {
          report.matches++;
          const warning = formatEnvironmentRule(shape, state.sessionCount, state.lastSeen);
          cost.run(call.session_id, Buffer.byteLength(warning, "utf8"), estimateTokens(warning));
          if (failed || call.outcome === "succeeded") report.resolvedMatches++;
          else if (call.outcome === "unknown" || call.outcome === "denied" || call.outcome === "interrupted") {
            report.excludedOutcomes[call.outcome]++;
          }
        }
        if (failed) {
          if (matched) report.matchedFailures++;
          else report.unmatchedFailures++;
          if (!state) {
            state = { sessionCount: 0, lastSeen: call.seen, retired: false };
            shapes.set(shape, state);
          }
          if (!state.retired) {
            state.sessionCount += Number(failureSession.run(shape, call.session_id).changes);
            state.lastSeen = call.seen;
          }
        } else if (call.outcome === "succeeded" && state) {
          // A success before the first failure has no state to retire. Retirement is permanent.
          state.retired = true;
        }
      }
      scratch.exec("COMMIT");
    }
    if (report.calls) report.status = "measured";
    report.precision = report.resolvedMatches ? report.matchedFailures / report.resolvedMatches : null;
    const failures = report.matchedFailures + report.unmatchedFailures;
    report.coverage = failures ? report.matchedFailures / failures : null;
    const totals = scratch.prepare(`SELECT COUNT(*) AS sessions,
      COALESCE(SUM(bytes), 0) AS totalBytes, COALESCE(SUM(tokens), 0) AS totalTokens,
      COALESCE(AVG(bytes), 0) AS averageBytes, COALESCE(AVG(tokens), 0) AS averageTokens,
      COALESCE(MAX(bytes), 0) AS maxBytes, COALESCE(MAX(tokens), 0) AS maxTokens FROM costs`).get()!;
    for (const key of Object.keys(report.contextCost) as (keyof WarningBacktestReport["contextCost"])[]) {
      report.contextCost[key] = Number(totals[key]);
    }
    return report;
  } finally { scratch.close(); }
}

/** Open only the current project's store, read-only and without migrations or a daemon. */
export function collectWarningBacktest(cwd: string, paths: LcmPaths): WarningBacktestReport {
  const path = projectDbPath(cwd, paths);
  if (!existsSync(path)) return emptyReport();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA temp_store = FILE; PRAGMA cache_size = -1024");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_tool_calls'").get()) return emptyReport();
    return backtestWarnings(db);
  } catch {
    return { ...emptyReport(), status: "unavailable" };
  } finally { db?.close(); }
}

export function formatWarningBacktest(report: WarningBacktestReport): string {
  const prefix = "Environment warning backtest (current project): warnings stay off. ";
  if (report.status === "no-data") return prefix + "No stored calls; precision, coverage and context cost are unknown.";
  if (report.status === "unavailable") return prefix + "Stored evidence unavailable; precision, coverage and context cost are unknown.";
  const percent = (value: number | null) => value === null ? "unknown (no eligible denominator)" : `${(value * 100).toFixed(1)}%`;
  const excluded = report.excludedOutcomes;
  const cost = report.contextCost;
  return prefix + `${report.matches} matches / ${report.shapedCalls} shaped shell calls (${report.calls} stored calls).\n` +
    `Precision ${percent(report.precision)} (${report.matchedFailures}/${report.resolvedMatches} matched failed, blocked or succeeded calls failed or were blocked). ` +
    `Excluded matched outcomes: unknown: ${excluded.unknown}, denied: ${excluded.denied}, interrupted: ${excluded.interrupted}.\n` +
    `Coverage ${percent(report.coverage)} (${report.matchedFailures}/${report.matchedFailures + report.unmatchedFailures} failed or blocked shaped shell calls matched); ` +
    `${report.unmatchedFailures} failing calls had no match; ${report.unshapedFailures} shell failures without a shape excluded.\n` +
    `Would-be context cost (actually injected: 0): total ${cost.totalBytes} UTF-8 bytes, ~${cost.totalTokens} estimated tokens; ` +
    `per-session average ${cost.averageBytes.toFixed(1)} UTF-8 bytes, ~${cost.averageTokens.toFixed(1)} estimated tokens ` +
    `among ${cost.sessions} sessions with a match; per-session maximum ${cost.maxBytes} UTF-8 bytes, ~${cost.maxTokens} estimated tokens.`;
}
