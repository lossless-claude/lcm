/**
 * Durable progress for `--replay` runs (import and batch compact).
 *
 * Two tables per project DB (see db/migration.ts):
 *  - replay_manifest: the ordered session list frozen under a run_id.
 *  - replay_ledger:   one row per completed session compaction, written only
 *                     after the summary is persisted.
 *
 * Resume is the default: a new run adopts the latest manifest for its command,
 * skips ledger rows whose content fingerprint still matches, restores the
 * threaded `previousSummary` chain from the last good row, and continues.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { projectId } from "./daemon/project.js";
import { runLcmMigrations } from "./db/migration.js";

export type ReplayCommand = "import" | "compact";

export interface ReplayRunInfo {
  runId: string;
  command: ReplayCommand;
  model: string | null;
  createdAt: string;
}

export interface ReplayLedgerEntry {
  sessionId: string;
  position: number;
  prevSessionId: string | null;
  contentFingerprint: string;
  summaryId: string | null;
  model: string | null;
  completedAt: string;
}

export interface ReplayResumePlan<T extends { sessionId: string }> {
  runId: string;
  previousRunId: string | null;
  previousModel: string | null;
  /** Sessions to process in manifest order (changed, new, or previously failed). */
  remaining: T[];
  /** Number of sessions skipped because their ledger row fingerprint still matches. */
  doneCount: number;
  /** Threaded summary chain restored from the last done row that precedes the first remaining session. */
  restoredPreviousSummary: string | undefined;
  /** `undefined` when the restored chain is intact; otherwise the summary that was dropped. */
  droppedPreviousSummary: string | undefined;
  /** Session id whose content changed since its ledger row — downstream summaries were threaded against the older version. */
  changedSessionId: string | null;
}

export function replayRunId(): string {
  return randomUUID();
}

/**
 * Fingerprint for transcript content: size + line count + mtime.
 * Transcripts are append-only, so any append moves all three. Reading only the
 * first and last lines keeps the cost near zero (no full file parse).
 */
export function fingerprintFile(path: string): string {
  const st = statSync(path);
  const buf = readFileSync(path);
  const firstNl = buf.indexOf(0x0a);
  const lastNl = buf.lastIndexOf(0x0a);
  const firstLine = buf.subarray(0, firstNl === -1 ? buf.length : firstNl);
  const lastLine = lastNl <= 0 ? Buffer.alloc(0) : buf.subarray(lastNl + 1);
  let lines = 0;
  for (const b of buf) if (b === 0x0a) lines++;
  const hash = createHash("sha1").update(firstLine).update(lastLine).digest("hex");
  return `${st.size}:${lines}:${Math.floor(st.mtimeMs)}:${hash}`;
}

/**
 * Fingerprint for DB-backed sessions (batch compact has no transcript path):
 * message count + total tokens change whenever the conversation grows.
 */
export function fingerprintStats(messages: number, tokens: number): string {
  return `db:${messages}:${tokens}`;
}

function openProjectDb(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    // The daemon may hold connections opened before the replay tables existed;
    // runLcmMigrations is additive and idempotent, so this is a cheap no-op on
    // current databases and self-heals stale ones.
    runLcmMigrations(db, { fts5Available: false });
    db.prepare("SELECT 1 FROM replay_ledger LIMIT 1").get();
    return db;
  } catch {
    return null;
  }
}

function closeDb(db: DatabaseSync | null): void {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
}

function projectDbPathFor(cwd: string, lcmDir?: string): string {
  return lcmDir
    ? join(lcmDir, "projects", projectId(cwd), "db.sqlite")
    : join(homedir(), ".lossless-claude", "projects", projectId(cwd), "db.sqlite");
}

function loadLatestRun(db: DatabaseSync, command: ReplayCommand): ReplayRunInfo | null {
  const row = db.prepare(`
    SELECT run_id, command, model, MIN(created_at) AS created_at
    FROM replay_manifest
    WHERE command = ?
    GROUP BY run_id
    ORDER BY created_at DESC, run_id DESC
    LIMIT 1
  `).get(command) as { run_id: string; command: string; model: string | null; created_at: string } | undefined;
  if (!row) return null;
  return { runId: row.run_id, command: row.command as ReplayCommand, model: row.model, createdAt: row.created_at };
}

function loadManifestOrder(db: DatabaseSync, runId: string): string[] {
  const rows = db.prepare(
    "SELECT session_id FROM replay_manifest WHERE run_id = ? ORDER BY position ASC",
  ).all(runId) as { session_id: string }[];
  return rows.map((r) => r.session_id);
}

function loadLedger(db: DatabaseSync, runId: string): Map<string, ReplayLedgerEntry> {
  const rows = db.prepare(
    "SELECT session_id, position, prev_session_id, content_fingerprint, summary_id, model, completed_at FROM replay_ledger WHERE run_id = ?",
  ).all(runId) as {
    session_id: string; position: number; prev_session_id: string | null;
    content_fingerprint: string; summary_id: string | null; model: string | null; completed_at: string;
  }[];
  const map = new Map<string, ReplayLedgerEntry>();
  for (const r of rows) {
    map.set(r.session_id, {
      sessionId: r.session_id,
      position: r.position,
      prevSessionId: r.prev_session_id,
      contentFingerprint: r.content_fingerprint,
      summaryId: r.summary_id,
      model: r.model,
      completedAt: r.completed_at,
    });
  }
  return map;
}

function fetchSummaryContent(db: DatabaseSync, summaryId: string): string | undefined {
  const row = db.prepare("SELECT content FROM summaries WHERE summary_id = ?").get(summaryId) as
    | { content: string }
    | undefined;
  return row?.content;
}

/**
 * Persist a new run's manifest. Returns the new run_id.
 * No-op when `sessions` is empty or the DB cannot be opened.
 */
export function createReplayRun(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
  runId: string;
  sessions: { sessionId: string }[];
  model?: string | null;
}): void {
  const db = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (!db) return;
  try {
    db.exec("BEGIN");
    try {
      const stmt = db.prepare(
        "INSERT INTO replay_manifest (run_id, command, position, session_id, model) VALUES (?, ?, ?, ?, ?)",
      );
      opts.sessions.forEach((s, i) => {
        stmt.run(opts.runId, opts.command, i, s.sessionId, opts.model ?? null);
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch { /* resume state is best-effort — never fail the run */ }
  finally { closeDb(db); }
}

/**
 * Compute the resume plan for a replay run.
 *
 * When `restart` is set or no previous run exists, every session is returned as
 * remaining and a fresh manifest is the caller's job (see createReplayRun).
 */
export function planReplayResume<T extends { sessionId: string }>(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
  sessions: T[];
  fingerprint: (session: T) => string | null;
  restart?: boolean;
}): ReplayResumePlan<T> {
  const fresh: ReplayResumePlan<T> = {
    runId: replayRunId(),
    previousRunId: null,
    previousModel: null,
    remaining: [...opts.sessions],
    doneCount: 0,
    restoredPreviousSummary: undefined,
    droppedPreviousSummary: undefined,
    changedSessionId: null,
  };

  const db = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (!db) return fresh;
  try {
    const prev = loadLatestRun(db, opts.command);
    if (!prev || opts.restart) {
      return fresh;
    }

    const order = loadManifestOrder(db, prev.runId);
    const ledger = loadLedger(db, prev.runId);
    const positionOf = new Map(order.map((sid, i) => [sid, i]));

    const doneRows: { position: number; entry: ReplayLedgerEntry }[] = [];
    const remaining: T[] = [];
    let changedSessionId: string | null = null;

    for (const session of opts.sessions) {
      const entry = ledger.get(session.sessionId);
      let fp: string | null = null;
      try { fp = opts.fingerprint(session); } catch { fp = null; }
      if (entry && fp !== null && entry.contentFingerprint === fp) {
        doneRows.push({ position: positionOf.get(session.sessionId) ?? entry.position, entry });
      } else {
        if (entry && fp !== null && entry.contentFingerprint !== fp && changedSessionId === null) {
          changedSessionId = session.sessionId;
        }
        remaining.push(session);
      }
    }

    // Restore the threaded chain from the last done row that precedes the first
    // remaining session; if the chain was already broken there, drop it.
    const firstRemainingPos = remaining.length > 0
      ? (positionOf.get(remaining[0].sessionId) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const anchor = doneRows
      .filter((r) => r.position < firstRemainingPos)
      .sort((a, b) => b.position - a.position)[0];

    let restored: string | undefined;
    let dropped: string | undefined;
    if (anchor && anchor.entry.summaryId) {
      const content = fetchSummaryContent(db, anchor.entry.summaryId);
      if (content !== undefined) {
        // The chain is intact when every done row before the anchor also has a
        // summary; a NULL summary_id marks a link where the chain was broken.
        const broken = db.prepare(
          "SELECT 1 FROM replay_ledger WHERE run_id = ? AND position < ? AND summary_id IS NULL LIMIT 1",
        ).get(prev.runId, anchor.position);
        if (broken) {
          dropped = content;
        } else {
          restored = content;
        }
      }
    }

    return {
      runId: prev.runId,
      previousRunId: prev.runId,
      previousModel: prev.model,
      remaining,
      doneCount: doneRows.length,
      restoredPreviousSummary: restored,
      droppedPreviousSummary: dropped,
      changedSessionId,
    };
  } catch {
    return fresh;
  } finally {
    closeDb(db);
  }
}

/**
 * Record a completed session compaction. Must be called only after the
 * session's summary has been persisted (createdSummaryId in hand), so a ledger
 * row is always durable proof of done work.
 */
export function recordReplayProgress(opts: {
  cwd: string;
  lcmDir?: string;
  runId: string;
  sessionId: string;
  position: number;
  prevSessionId: string | null;
  contentFingerprint: string;
  summaryId?: string | null;
  model?: string | null;
}): void {
  const db = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO replay_ledger (run_id, session_id, position, prev_session_id, content_fingerprint, summary_id, model)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, session_id) DO UPDATE SET
        position = excluded.position,
        prev_session_id = excluded.prev_session_id,
        content_fingerprint = excluded.content_fingerprint,
        summary_id = excluded.summary_id,
        model = excluded.model,
        completed_at = datetime('now')
    `).run(
      opts.runId,
      opts.sessionId,
      opts.position,
      opts.prevSessionId,
      opts.contentFingerprint,
      opts.summaryId ?? null,
      opts.model ?? null,
    );
  } catch { /* ledger writes are best-effort — the next run re-does the work */ }
  finally { closeDb(db); }
}

/**
 * `--restart`: delete ledger rows for this command's runs, plus the summaries
 * they recorded (replay output only — hook-written summaries are untouched).
 */
export function clearReplayState(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
}): void {
  const db = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (!db) return;
  try {
    db.exec("BEGIN");
    try {
      db.prepare(`
        DELETE FROM summaries
        WHERE summary_id IN (
          SELECT l.summary_id FROM replay_ledger l
          JOIN replay_manifest m ON m.run_id = l.run_id
          WHERE m.command = ? AND l.summary_id IS NOT NULL
        )
      `).run(opts.command);
      db.prepare(
        "DELETE FROM replay_ledger WHERE run_id IN (SELECT DISTINCT run_id FROM replay_manifest WHERE command = ?)",
      ).run(opts.command);
      db.prepare("DELETE FROM replay_manifest WHERE command = ?").run(opts.command);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch { /* best-effort */ }
  finally { closeDb(db); }
}
