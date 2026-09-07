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
 * State is keyed per project (cwd); a run spanning multiple projects keeps one
 * manifest + ledger set per project database.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { projectId } from "./daemon/project.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
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

type ProjectDbOpenResult =
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ready"; db: DatabaseSync; dbPath: string };

interface ProjectPlan<T extends { sessionId: string }> {
  runId: string;
  previousRunId: string | null;
  previousModel: string | null;
  doneCount: number;
  remaining: T[];
  /** session_id → frozen manifest position (resumed projects only). */
  positions: Map<string, number>;
  restoredPreviousSummary: string | undefined;
  droppedPreviousSummary: string | undefined;
  changedSessionIds: string[];
  manifestOrder: string[];
  manifestAppends: string[];
}

export interface ReplayResumePlan<T extends { sessionId: string }> {
  /** cwd → run_id (fresh id for projects with no prior run, adopted id otherwise). */
  runIds: Map<string, string>;
  /** cwd → frozen manifest order for that project (existing or to-be-created). */
  manifests: Map<string, string[]>;
  /** cwd → session_id → manifest position, for resumed projects. */
  positions: Map<string, Map<string, number>>;
  /** cwd → newly discovered session_ids appended to adopted manifests. */
  manifestAppends: Map<string, string[]>;
  /** Projects with no prior run — caller must create their manifests. */
  freshCwds: Set<string>;
  /** Sessions to process in input order (changed, new, or previously failed). */
  remaining: T[];
  /** Sessions skipped because their ledger row fingerprint still matches. */
  doneCount: number;
  /** Model recorded on the most recently resumed run, when they differ across projects. */
  previousModel: string | null;
  /** Threaded summary chain restored across the resumed projects' last good rows. */
  restoredPreviousSummary: string | undefined;
  /** Set when the restored chain was dropped because a prior link was broken. */
  droppedPreviousSummary: string | undefined;
  /** cwd → per-project restored threaded summary content. */
  restoredPreviousSummaries: Map<string, string>;
  /** cwd → per-project dropped threaded summary content warning marker. */
  droppedPreviousSummaries: Map<string, string>;
  /** Session ids whose content changed since their ledger row. */
  changedSessionIds: string[];
}

export function replayRunId(): string {
  return randomUUID();
}

/**
 * Fingerprint for transcript content: size + mtime.
 * Transcripts are append-only, so appends move at least one of these.
 */
export function fingerprintFile(path: string): string {
  const st = statSync(path);
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

/**
 * Fingerprint for DB-backed sessions (batch compact has no transcript path):
 * message count + total tokens change whenever the conversation grows.
 */
export function fingerprintStats(messages: number, tokens: number): string {
  return `db:${messages}:${tokens}`;
}

// runLcmMigrations includes unconditional summary backfills, so run it at most
// once per process per database instead of on every ledger write.
const migratedDbPaths = new Set<string>();

function openProjectDb(dbPath: string): ProjectDbOpenResult {
  if (!existsSync(dbPath)) return { kind: "missing" };
  let db: DatabaseSync | null = null;
  try {
    db = getLcmConnection(dbPath);
    if (!migratedDbPaths.has(dbPath)) {
      // The daemon may hold connections opened before the replay tables
      // existed; the sweep is additive and idempotent, so this self-heals
      // stale databases and is skipped on every later open.
      runLcmMigrations(db, { fts5Available: false });
      migratedDbPaths.add(dbPath);
    }
    db.prepare("SELECT 1 FROM replay_ledger LIMIT 1").get();
    return { kind: "ready", db, dbPath };
  } catch {
    if (db) {
      closeLcmConnection(dbPath);
    }
    return { kind: "error" };
  }
}

function closeDb(opened: ProjectDbOpenResult): void {
  if (opened.kind !== "ready") return;
  try { closeLcmConnection(opened.dbPath); } catch { /* already closed */ }
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
 * Persist a new run's manifest. No-op when `sessions` is empty or the DB
 * cannot be opened.
 */
export function createReplayRun(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
  runId: string;
  sessions: { sessionId: string }[];
  model?: string | null;
}): void {
  const opened = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (opened.kind !== "ready") return;
  const { db } = opened;
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
  finally { closeDb(opened); }
}

/**
 * Append new sessions to an adopted manifest, preserving prior positions.
 * Existing (run_id, position) rows are left untouched.
 */
export function appendReplayManifestSessions(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
  runId: string;
  sessions: { sessionId: string; position: number }[];
  model?: string | null;
}): void {
  if (opts.sessions.length === 0) return;
  const opened = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (opened.kind !== "ready") return;
  const { db } = opened;
  try {
    db.exec("BEGIN");
    try {
      const stmt = db.prepare(
        "INSERT OR IGNORE INTO replay_manifest (run_id, command, position, session_id, model) VALUES (?, ?, ?, ?, ?)",
      );
      for (const session of opts.sessions) {
        stmt.run(opts.runId, opts.command, session.position, session.sessionId, opts.model ?? null);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch { /* resume state is best-effort — never fail the run */ }
  finally { closeDb(opened); }
}

/** Plan one project against its own database. Returns null when the DB is unusable. */
function planProject<T extends { sessionId: string }>(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
  sessions: T[];
  fingerprint: (session: T) => string | null;
  restart?: boolean;
}): ProjectPlan<T> | null {
  const freshProject: ProjectPlan<T> = {
    runId: replayRunId(),
    previousRunId: null,
    previousModel: null,
    doneCount: 0,
    remaining: [...opts.sessions],
    positions: new Map(),
    restoredPreviousSummary: undefined,
    droppedPreviousSummary: undefined,
    changedSessionIds: [],
    manifestOrder: opts.sessions.map((s) => s.sessionId),
    manifestAppends: [],
  };

  const opened = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (opened.kind !== "ready") return null;
  const { db } = opened;
  try {
    const prev = loadLatestRun(db, opts.command);
    if (!prev || opts.restart) {
      return freshProject;
    }

    const order = loadManifestOrder(db, prev.runId);
    const ledger = loadLedger(db, prev.runId);
    const positionOf = new Map(order.map((sid, i) => [sid, i]));
    const appended: string[] = [];
    for (const session of opts.sessions) {
      if (positionOf.has(session.sessionId)) continue;
      positionOf.set(session.sessionId, order.length);
      order.push(session.sessionId);
      appended.push(session.sessionId);
    }
    const sessionById = new Map(opts.sessions.map((session) => [session.sessionId, session]));

    const doneRows: { position: number; entry: ReplayLedgerEntry }[] = [];
    const remaining: T[] = [];
    const changedSessionIds: string[] = [];
    let seenGap = false;
    for (const sessionId of order) {
      const session = sessionById.get(sessionId);
      if (!session) continue;
      const entry = ledger.get(sessionId);
      let fp: string | null = null;
      try { fp = opts.fingerprint(session); } catch { fp = null; }
      const isDone = !seenGap && !!entry && fp !== null && entry.contentFingerprint === fp;
      if (isDone) {
        doneRows.push({ position: positionOf.get(sessionId) ?? entry.position, entry });
        continue;
      }
      seenGap = true;
      if (entry && fp !== null && entry.contentFingerprint !== fp) {
        changedSessionIds.push(sessionId);
      }
      remaining.push(session);
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
      doneCount: doneRows.length,
      remaining,
      positions: positionOf,
      restoredPreviousSummary: restored,
      droppedPreviousSummary: dropped,
      changedSessionIds,
      manifestOrder: order,
      manifestAppends: appended,
    };
  } catch {
    return null;
  } finally {
    closeDb(opened);
  }
}

/**
 * Compute the resume plan for a replay run, spanning every project the
 * sessions belong to. Sessions are grouped by their own cwd; each group is
 * planned against that project's database. When `restart` is set or a project
 * has no previous run, its sessions are all remaining and the caller creates a
 * fresh manifest for it (see createReplayRun).
 */
export function planReplayResume<T extends { sessionId: string; cwd: string }>(opts: {
  sessions: T[];
  lcmDir?: string;
  command: ReplayCommand;
  fingerprint: (session: T) => string | null;
  restart?: boolean;
}): ReplayResumePlan<T> {
  const plan: ReplayResumePlan<T> = {
    runIds: new Map(),
    manifests: new Map(),
    positions: new Map(),
    manifestAppends: new Map(),
    freshCwds: new Set(),
    remaining: [],
    doneCount: 0,
    previousModel: null,
    restoredPreviousSummary: undefined,
    droppedPreviousSummary: undefined,
    restoredPreviousSummaries: new Map(),
    droppedPreviousSummaries: new Map(),
    changedSessionIds: [],
  };

  // Group by project, preserving input order within each group.
  const byCwd = new Map<string, T[]>();
  for (const session of opts.sessions) {
    const list = byCwd.get(session.cwd) ?? [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }

  const firstInputIdxByCwd = new Map<string, number>();
  opts.sessions.forEach((session, index) => {
    if (!firstInputIdxByCwd.has(session.cwd)) firstInputIdxByCwd.set(session.cwd, index);
  });

  // Chain restore candidates across projects, ordered by each project's first
  // remaining session position in the input list.
  const chainCandidates: { firstInputIdx: number; restored?: string; dropped?: string }[] = [];
  const remainingByCwd = new Map<string, T[]>();

  for (const [cwd, sessions] of byCwd) {
    const project: ProjectPlan<T> = planProject({
      cwd,
      lcmDir: opts.lcmDir,
      command: opts.command,
      sessions,
      fingerprint: opts.fingerprint,
      restart: opts.restart,
    }) ?? {
      // DB unusable — treat as fresh; resume is best-effort.
      runId: replayRunId(),
      previousRunId: null,
      previousModel: null,
      doneCount: 0,
      remaining: [...sessions],
      positions: new Map<string, number>(),
      restoredPreviousSummary: undefined,
      droppedPreviousSummary: undefined,
      changedSessionIds: [],
      manifestOrder: sessions.map((s) => s.sessionId),
      manifestAppends: [],
    };

    plan.runIds.set(cwd, project.runId);
    plan.manifests.set(cwd, project.manifestOrder);
    plan.manifestAppends.set(cwd, project.manifestAppends);
    if (project.previousRunId === null) {
      plan.freshCwds.add(cwd);
      const positions = new Map<string, number>();
      project.manifestOrder.forEach((sid, i) => positions.set(sid, i));
      plan.positions.set(cwd, positions);
    } else {
      plan.positions.set(cwd, project.positions);
      plan.doneCount += project.doneCount;
      if (project.previousModel) plan.previousModel = project.previousModel;
      if (project.changedSessionIds.length > 0) plan.changedSessionIds.push(...project.changedSessionIds);
      if (project.restoredPreviousSummary !== undefined) {
        plan.restoredPreviousSummaries.set(cwd, project.restoredPreviousSummary);
      }
      if (project.droppedPreviousSummary !== undefined) {
        plan.droppedPreviousSummaries.set(cwd, project.droppedPreviousSummary);
      }
      if (project.restoredPreviousSummary !== undefined || project.droppedPreviousSummary !== undefined) {
        const anchor = project.remaining.length > 0 ? project.remaining[0] : sessions[sessions.length - 1];
        chainCandidates.push({
          firstInputIdx: opts.sessions.indexOf(anchor),
          restored: project.restoredPreviousSummary,
          dropped: project.droppedPreviousSummary,
        });
      }
    }
    remainingByCwd.set(cwd, project.remaining);
  }

  // Keep project discovery order from input; within each project, use manifest order.
  const projectOrder = new Map<string, number>();
  let projectCursor = 0;
  for (const s of opts.sessions) {
    if (!projectOrder.has(s.cwd)) {
      projectOrder.set(s.cwd, projectCursor++);
    }
  }
  const flattenedRemaining: T[] = [];
  for (const [cwd, list] of remainingByCwd) {
    for (const session of list) flattenedRemaining.push(session);
  }
  plan.remaining = flattenedRemaining.sort((a, b) => {
    const projectRank = (projectOrder.get(a.cwd) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.cwd) ?? Number.MAX_SAFE_INTEGER);
    if (projectRank !== 0) return projectRank;
    const posA = plan.positions.get(a.cwd)?.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER;
    const posB = plan.positions.get(b.cwd)?.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER;
    if (posA !== posB) return posA - posB;
    return (firstInputIdxByCwd.get(a.cwd) ?? Number.MAX_SAFE_INTEGER) - (firstInputIdxByCwd.get(b.cwd) ?? Number.MAX_SAFE_INTEGER);
  });

  // The threaded chain resumes from the project whose remaining work starts
  // earliest in the input order.
  chainCandidates.sort((a, b) => a.firstInputIdx - b.firstInputIdx);
  const chain = chainCandidates[0];
  if (chain) {
    plan.restoredPreviousSummary = chain.restored;
    plan.droppedPreviousSummary = chain.dropped;
  }

  return plan;
}

/**
 * Record a completed session compaction. Must be called only after the
 * session's summary has been persisted (latestSummaryId in hand), so a ledger
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
  summaryIds?: string[];
  model?: string | null;
}): void {
  const opened = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (opened.kind !== "ready") return;
  const { db } = opened;
  try {
    db.exec("BEGIN");
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
      const uniqueSummaryIds = Array.from(new Set((opts.summaryIds ?? []).filter((id) => id.trim().length > 0)));
      db.prepare(
        "DELETE FROM replay_ledger_summaries WHERE run_id = ? AND session_id = ?",
      ).run(opts.runId, opts.sessionId);
      if (uniqueSummaryIds.length > 0) {
        const summaryStmt = db.prepare(
          "INSERT INTO replay_ledger_summaries (run_id, session_id, summary_id, ordinal) VALUES (?, ?, ?, ?)",
        );
        uniqueSummaryIds.forEach((summaryId, ordinal) => {
          summaryStmt.run(opts.runId, opts.sessionId, summaryId, ordinal);
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch { /* ledger writes are best-effort — the next run re-does the work */ }
  finally { closeDb(opened); }
}

function loadReplaySummaryIds(db: DatabaseSync, command: ReplayCommand): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT summary_id
    FROM (
      SELECT l.summary_id AS summary_id
      FROM replay_ledger l
      JOIN replay_manifest m ON m.run_id = l.run_id
      WHERE m.command = ? AND l.summary_id IS NOT NULL
      UNION ALL
      SELECT ls.summary_id AS summary_id
      FROM replay_ledger_summaries ls
      JOIN replay_manifest m ON m.run_id = ls.run_id
      WHERE m.command = ?
    )
  `).all(command, command) as { summary_id: string }[];
  return rows.map((row) => row.summary_id);
}

function expandSummaryToMessageIds(db: DatabaseSync, summaryId: string, conversationId: number): number[] {
  const rows = db.prepare(`
    WITH RECURSIVE lineage(summary_id) AS (
      SELECT ?
      UNION ALL
      SELECT sp.parent_summary_id
      FROM summary_parents sp
      JOIN lineage l ON l.summary_id = sp.summary_id
    )
    SELECT DISTINCT m.message_id, m.seq
    FROM summary_messages sm
    JOIN lineage l ON l.summary_id = sm.summary_id
    JOIN messages m ON m.message_id = sm.message_id
    WHERE m.conversation_id = ?
    ORDER BY m.seq ASC, m.message_id ASC
  `).all(summaryId, conversationId) as { message_id: number; seq: number }[];
  return rows.map((row) => row.message_id);
}

function restoreContextFromReplaySummaries(db: DatabaseSync, replaySummaryIds: string[]): void {
  if (replaySummaryIds.length === 0) return;
  const replaySummarySet = new Set(replaySummaryIds);
  const rows = db.prepare(`
    SELECT conversation_id, ordinal, item_type, message_id, summary_id
    FROM context_items
    ORDER BY conversation_id ASC, ordinal ASC
  `).all() as Array<{
    conversation_id: number;
    ordinal: number;
    item_type: "message" | "summary";
    message_id: number | null;
    summary_id: string | null;
  }>;

  const byConversation = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byConversation.get(row.conversation_id) ?? [];
    list.push(row);
    byConversation.set(row.conversation_id, list);
  }

  const expandedCache = new Map<string, number[]>();
  for (const [conversationId, contextRows] of byConversation) {
    let touched = false;
    const rewritten: Array<{ itemType: "message" | "summary"; messageId: number | null; summaryId: string | null }> = [];
    for (const row of contextRows) {
      if (row.item_type === "summary" && row.summary_id && replaySummarySet.has(row.summary_id)) {
        touched = true;
        let messageIds = expandedCache.get(row.summary_id);
        if (!messageIds) {
          messageIds = expandSummaryToMessageIds(db, row.summary_id, conversationId);
          expandedCache.set(row.summary_id, messageIds);
        }
        for (const messageId of messageIds) {
          rewritten.push({ itemType: "message", messageId, summaryId: null });
        }
      } else {
        rewritten.push({
          itemType: row.item_type,
          messageId: row.message_id,
          summaryId: row.summary_id,
        });
      }
    }

    if (!touched) continue;
    db.prepare("DELETE FROM context_items WHERE conversation_id = ?").run(conversationId);
    const insert = db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id) VALUES (?, ?, ?, ?, ?)",
    );
    rewritten.forEach((item, ordinal) => {
      insert.run(conversationId, ordinal, item.itemType, item.messageId, item.summaryId);
    });
  }
}

/**
 * `--restart`: delete ledger rows for this command's runs, plus the summaries
 * they recorded (replay output only — hook-written summaries are untouched).
 * Dependent rows in context_items / summary_parents / summary_messages are
 * removed for the ledger-recorded summaries only. Returns false when the clear
 * could not complete, so callers can warn instead of silently keeping state.
 */
export function clearReplayState(opts: {
  cwd: string;
  lcmDir?: string;
  command: ReplayCommand;
}): boolean {
  const opened = openProjectDb(projectDbPathFor(opts.cwd, opts.lcmDir));
  if (opened.kind === "missing") return true; // nothing to clear
  if (opened.kind === "error") return false; // existing DB could not be opened
  const { db } = opened;
  try {
    db.exec("BEGIN");
    try {
      const replaySummaryIds = loadReplaySummaryIds(db, opts.command);
      restoreContextFromReplaySummaries(db, replaySummaryIds);
      db.prepare(`
        DELETE FROM context_items
        WHERE summary_id IN (
          SELECT summary_id FROM (
            SELECT l.summary_id AS summary_id
            FROM replay_ledger l
            JOIN replay_manifest m ON m.run_id = l.run_id
            WHERE m.command = ? AND l.summary_id IS NOT NULL
            UNION ALL
            SELECT ls.summary_id AS summary_id
            FROM replay_ledger_summaries ls
            JOIN replay_manifest m ON m.run_id = ls.run_id
            WHERE m.command = ?
          )
        )
      `).run(opts.command, opts.command);
      db.prepare(`
        DELETE FROM summary_parents
        WHERE summary_id IN (
          SELECT summary_id FROM (
            SELECT l.summary_id AS summary_id
            FROM replay_ledger l
            JOIN replay_manifest m ON m.run_id = l.run_id
            WHERE m.command = ? AND l.summary_id IS NOT NULL
            UNION ALL
            SELECT ls.summary_id AS summary_id
            FROM replay_ledger_summaries ls
            JOIN replay_manifest m ON m.run_id = ls.run_id
            WHERE m.command = ?
          )
        )
        OR parent_summary_id IN (
          SELECT summary_id FROM (
            SELECT l.summary_id AS summary_id
            FROM replay_ledger l
            JOIN replay_manifest m ON m.run_id = l.run_id
            WHERE m.command = ? AND l.summary_id IS NOT NULL
            UNION ALL
            SELECT ls.summary_id AS summary_id
            FROM replay_ledger_summaries ls
            JOIN replay_manifest m ON m.run_id = ls.run_id
            WHERE m.command = ?
          )
        )
      `).run(opts.command, opts.command, opts.command, opts.command);
      db.prepare(`
        DELETE FROM summary_messages
        WHERE summary_id IN (
          SELECT summary_id FROM (
            SELECT l.summary_id AS summary_id
            FROM replay_ledger l
            JOIN replay_manifest m ON m.run_id = l.run_id
            WHERE m.command = ? AND l.summary_id IS NOT NULL
            UNION ALL
            SELECT ls.summary_id AS summary_id
            FROM replay_ledger_summaries ls
            JOIN replay_manifest m ON m.run_id = ls.run_id
            WHERE m.command = ?
          )
        )
      `).run(opts.command, opts.command);
      db.prepare(`
        DELETE FROM summaries
        WHERE summary_id IN (
          SELECT summary_id FROM (
            SELECT l.summary_id AS summary_id
            FROM replay_ledger l
            JOIN replay_manifest m ON m.run_id = l.run_id
            WHERE m.command = ? AND l.summary_id IS NOT NULL
            UNION ALL
            SELECT ls.summary_id AS summary_id
            FROM replay_ledger_summaries ls
            JOIN replay_manifest m ON m.run_id = ls.run_id
            WHERE m.command = ?
          )
        )
      `).run(opts.command, opts.command);
      db.prepare(
        "DELETE FROM replay_ledger_summaries WHERE run_id IN (SELECT DISTINCT run_id FROM replay_manifest WHERE command = ?)",
      ).run(opts.command);
      db.prepare(
        "DELETE FROM replay_ledger WHERE run_id IN (SELECT DISTINCT run_id FROM replay_manifest WHERE command = ?)",
      ).run(opts.command);
      db.prepare("DELETE FROM replay_manifest WHERE command = ?").run(opts.command);
      db.exec("COMMIT");
      return true;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch {
    return false;
  } finally {
    closeDb(opened);
  }
}
