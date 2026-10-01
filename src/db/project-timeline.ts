import type { DatabaseSync } from "node:sqlite";

export const TIMELINE_SESSION_ID = "lcm:project-timeline";

/** The owner is created only when timeline work is requested. */
export function ensureTimelineOwner(db: DatabaseSync): number {
  db.prepare("INSERT OR IGNORE INTO conversations(session_id, title, is_timeline) VALUES (?, 'Project timeline', 1)")
    .run(TIMELINE_SESSION_ID);
  return (db.prepare("SELECT conversation_id FROM conversations WHERE is_timeline = 1").get() as { conversation_id: number }).conversation_id;
}

/** Install beside the source tables so every writer participates without a callback. */
export function installProjectTimeline(db: DatabaseSync): void {
  db.exec("DROP TRIGGER IF EXISTS timeline_replay_complete");
  installTimelineTables(db);
  const tracking = db.prepare("SELECT tracking FROM timeline_state WHERE id = 1").get() as { tracking: number };
  if (tracking.tracking) installTimelineTriggers(db);
  else dropTimelineTriggers(db);
  archiveTimelinePromotions(db);
}

function installTimelineTables(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "is_timeline")) {
    db.exec("ALTER TABLE conversations ADD COLUMN is_timeline INTEGER NOT NULL DEFAULT 0 CHECK (is_timeline IN (0, 1))");
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS timeline_owner_idx ON conversations(is_timeline) WHERE is_timeline = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS timeline_session_idx ON conversations(session_id) WHERE session_id = 'lcm:project-timeline';
    CREATE TABLE IF NOT EXISTS timeline_nodes (
      summary_id TEXT PRIMARY KEY REFERENCES summaries(summary_id) ON DELETE CASCADE,
      work_key TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'period' CHECK(level IN ('digest', 'period')),
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      generator TEXT NOT NULL,
      replaces TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      stale_reason TEXT,
      stale_since TEXT
    );
    CREATE INDEX IF NOT EXISTS timeline_work_idx ON timeline_nodes(work_key, active);
    CREATE TABLE IF NOT EXISTS timeline_sources (
      summary_id TEXT NOT NULL REFERENCES timeline_nodes(summary_id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      summary_ids TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      message_range TEXT,
      PRIMARY KEY(summary_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS timeline_source_idx ON timeline_sources(conversation_id);
    CREATE TABLE IF NOT EXISTS timeline_memory_refs (
      summary_id TEXT NOT NULL REFERENCES timeline_nodes(summary_id) ON DELETE CASCADE,
      memory_id TEXT NOT NULL,
      revision TEXT NOT NULL,
      PRIMARY KEY(summary_id, memory_id)
    );
    CREATE INDEX IF NOT EXISTS timeline_memory_idx ON timeline_memory_refs(memory_id);
    CREATE TABLE IF NOT EXISTS timeline_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), tracking INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'off',
      bootstrap_cursor TEXT NOT NULL DEFAULT '', reconcile_cursor INTEGER NOT NULL DEFAULT 0,
      generator TEXT, published INTEGER NOT NULL DEFAULT 0, admission_recovered INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS timeline_dirty (
      session_id TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL DEFAULT 'session-changed', bumped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS timeline_dirty_ready_idx ON timeline_dirty(dirty, session_id);
    CREATE TABLE IF NOT EXISTS timeline_sessions (session_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS timeline_items (
      item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, conversation_id INTEGER NOT NULL,
      month TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS timeline_item_session_idx ON timeline_items(session_id);
    CREATE INDEX IF NOT EXISTS timeline_item_month_idx ON timeline_items(month);
    CREATE TABLE IF NOT EXISTS timeline_units (
      work_key TEXT PRIMARY KEY, level TEXT NOT NULL, month TEXT NOT NULL, metadata TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready', failures INTEGER NOT NULL DEFAULT 0, next_try TEXT,
      period_to TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS timeline_unit_month_idx ON timeline_units(month);
    CREATE INDEX IF NOT EXISTS timeline_unit_ready_idx ON timeline_units(status, period_to);
    CREATE TABLE IF NOT EXISTS timeline_months (month TEXT PRIMARY KEY, replan INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS timeline_memory_dirty (memory_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS timeline_reconcile (conversation_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
    DROP TABLE IF EXISTS timeline_input_cache_batches;
    DROP TABLE IF EXISTS timeline_input_cache;
    DROP TABLE IF EXISTS timeline_journal;
    DROP TABLE IF EXISTS timeline_checkpoint;
    CREATE INDEX IF NOT EXISTS timeline_source_session_idx ON timeline_sources(session_id);
    CREATE INDEX IF NOT EXISTS timeline_active_idx ON timeline_nodes(active, stale_reason);
    CREATE INDEX IF NOT EXISTS timeline_replay_session_idx ON replay_manifest(session_id, run_id);
  `);
  if (!db.prepare("SELECT 1 FROM timeline_state WHERE id = 1").get()) {
    db.exec("INSERT OR IGNORE INTO timeline_state(id) VALUES (1)");
  }
  const stateColumns = db.prepare("PRAGMA table_info(timeline_state)").all() as Array<{ name: string }>;
  if (!stateColumns.some(column => column.name === "admission_recovered")) {
    db.exec("ALTER TABLE timeline_state ADD COLUMN admission_recovered INTEGER NOT NULL DEFAULT 0");
  }
  if (stateColumns.some(column => column.name === "drain")) {
    db.exec("ALTER TABLE timeline_state DROP COLUMN drain");
  }
}

function installTimelineTriggers(db: DatabaseSync): void {
  // Context order is derived from the summary DAG. Only compaction parts change raw membership.
  for (const table of ["context_items"]) for (const operation of ["insert", "update", "delete"]) {
    for (const row of ["new", "old"]) db.exec(`DROP TRIGGER IF EXISTS timeline_${table}_${operation}_${row}`);
  }
  db.exec("DROP TRIGGER IF EXISTS timeline_conversations_update_old");
  for (const [name, sql] of timelineTriggerSql()) {
    const prior = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
    if (prior && normalizedTriggerSql(prior.sql) === normalizedTriggerSql(sql)) continue;
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(sql);
  }
}

function normalizedTriggerSql(value: string): string { return value.replace(/\s+/g, " ").trim(); }

/** Compare the installed definitions without changing tracking or source rows. */
export function timelineTriggerIssues(db: DatabaseSync): string[] {
  const installed = new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'")
    .all() as Array<{ name: string; sql: string }>).map(row => [row.name, row.sql]));
  const issues: string[] = [];
  for (const [name, sql] of timelineTriggerSql()) {
    const prior = installed.get(name);
    if (!prior) issues.push(`missing: ${name}`);
    else if (normalizedTriggerSql(prior) !== normalizedTriggerSql(sql)) issues.push(`outdated: ${name}`);
  }
  return issues;
}

function timelineTriggerSql(): Map<string, string> {
  const triggers = new Map<string, string>();
  const install = (name: string, body: string) => { triggers.set(name, `CREATE TRIGGER ${name} ${body}`); };
  const bump = (session: string, reason = "session-changed") => `
    INSERT INTO timeline_dirty(session_id, rev, dirty, reason, bumped_at) VALUES (${session}, 1, 1, '${reason}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(session_id) DO UPDATE SET rev = rev + 1, dirty = 1, reason = '${reason}', bumped_at = excluded.bumped_at;`;
  const flagSession = (conversation: string, reason = "session-changed", detach = false) => `
    ${bump(`(SELECT session_id FROM conversations WHERE conversation_id = ${conversation})`, reason)}
    ${detach ? `UPDATE timeline_nodes SET stale_reason = COALESCE(stale_reason, '${reason}'),
      stale_since = COALESCE(stale_since, datetime('now'))
      WHERE summary_id IN (SELECT summary_id FROM timeline_sources WHERE conversation_id = ${conversation});` : ""}`;
  const sessionTrigger = ({ table, operation, row, conversation, before = false, extra = "", condition = "1" }: {
    table: string; operation: string; row: string; conversation: string; before?: boolean; extra?: string; condition?: string;
  }) => {
    install(`timeline_${table}_${operation}_${row.toLowerCase()}`, `
      ${before ? "BEFORE" : "AFTER"} ${operation.toUpperCase()} ON ${table}
      WHEN (${condition}) AND EXISTS (SELECT 1 FROM conversations WHERE conversation_id = ${conversation} AND is_timeline = 0)
      BEGIN
        ${flagSession(conversation, table === "conversations" && operation === "delete" ? "session-removed" : "session-changed", operation === "delete")}
        ${extra}
      END`);
  };
  for (const table of ["messages", "summaries", "conversations"]) {
    for (const operation of ["insert", "update", "delete"]) {
      const row = operation === "delete" ? "OLD" : "NEW";
      const conversation = `${row}.conversation_id`;
      const extra = table === "summaries" && operation === "delete"
        ? "DELETE FROM summary_parents WHERE parent_summary_id = OLD.summary_id AND summary_id IN (SELECT summary_id FROM timeline_nodes);"
        : table === "messages" && operation === "delete"
          ? "DELETE FROM summary_messages WHERE message_id = OLD.message_id AND summary_id IN (SELECT summary_id FROM timeline_nodes);"
          : table === "conversations" && operation === "delete"
            ? `DELETE FROM summary_parents WHERE parent_summary_id IN
                 (SELECT summary_id FROM summaries WHERE conversation_id = OLD.conversation_id)
                 AND summary_id IN (SELECT summary_id FROM timeline_nodes);
               DELETE FROM summary_messages WHERE message_id IN
                 (SELECT message_id FROM messages WHERE conversation_id = OLD.conversation_id)
                 AND summary_id IN (SELECT summary_id FROM timeline_nodes);`
            : "";
      sessionTrigger({ table, operation, row, conversation, before: operation === "delete", extra });
      // Moving a row changes membership on both sides.
      if (operation === "update" && table !== "conversations") sessionTrigger({ table, operation, row: "OLD", conversation: "OLD.conversation_id", condition: "OLD.conversation_id IS NOT NEW.conversation_id" });
      if (operation === "update" && table === "conversations") install("timeline_conversations_rename", `AFTER UPDATE ON conversations
        WHEN OLD.is_timeline = 0 AND OLD.session_id IS NOT NEW.session_id BEGIN ${bump("OLD.session_id", "session-removed")} END`);
    }
  }
  for (const table of ["summary_parents", "summary_messages", "message_parts"]) {
    for (const operation of ["insert", "update", "delete"]) {
      for (const row of operation === "update" ? ["NEW", "OLD"] : [operation === "delete" ? "OLD" : "NEW"]) {
        const conversation = table === "message_parts"
          ? `(SELECT conversation_id FROM messages WHERE message_id = ${row}.message_id)`
          : `(SELECT conversation_id FROM summaries WHERE summary_id = ${row}.summary_id)`;
        let condition = table === "message_parts"
          ? operation === "update" ? "(OLD.part_type = 'compaction' OR NEW.part_type = 'compaction') AND (OLD.part_type IS NOT NEW.part_type OR OLD.message_id IS NOT NEW.message_id)" : `${row}.part_type = 'compaction'`
          : "1";
        if (operation === "update" && row === "OLD") {
          const ownerKey = table === "message_parts" ? "message_id" : "summary_id";
          condition += ` AND OLD.${ownerKey} IS NOT NEW.${ownerKey}`;
        }
        sessionTrigger({ table, operation, row, conversation, before: operation === "delete", condition });
      }
    }
  }
  for (const operation of ["insert", "update", "delete"]) {
    const row = operation === "delete" ? "OLD" : "NEW";
    install(`timeline_promoted_${operation}`, `AFTER ${operation.toUpperCase()} ON promoted
      WHEN 1
      ${operation === "update" ? `AND (OLD.content IS NOT NEW.content OR OLD.tags IS NOT NEW.tags
        OR OLD.archived_at IS NOT NEW.archived_at)` : ""}
      BEGIN
        INSERT OR IGNORE INTO timeline_memory_dirty VALUES (${row}.id);
        UPDATE timeline_nodes SET stale_reason = COALESCE(stale_reason, 'memory-changed'),
          stale_since = COALESCE(stale_since, datetime('now'))
          WHERE summary_id IN (SELECT summary_id FROM timeline_memory_refs WHERE memory_id = ${row}.id);
      END`);
  }
  for (const operation of ["insert", "update", "delete"]) {
    const row = operation === "delete" ? "OLD" : "NEW";
    install(`timeline_replay_${operation}`, `AFTER ${operation.toUpperCase()} ON replay_manifest
      WHEN 1
      BEGIN
        ${bump(`${row}.session_id`)}
      END`);
  }
  return triggers;
}

function dropTimelineTriggers(db: DatabaseSync): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").all() as Array<{ name: string }>;
  for (const row of rows) db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
}
function transaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Enable tracking before any paged bootstrap reads; seeding never overwrites counters. */
export function enableTimeline(db: DatabaseSync): void {
  transaction(db, () => {
    installTimelineTriggers(db);
    db.exec("UPDATE timeline_state SET tracking = 1, generation = 1, phase = 'bootstrapping', bootstrap_cursor = '' WHERE id = 1");
  });
}
/** Generation may stop while tracking and deletion safety remain installed. */
export function disableTimeline(db: DatabaseSync): void {
  transaction(db, () => { db.exec("UPDATE timeline_state SET generation = 0 WHERE id = 1"); });
}
/** Remove dependent references before removing deletion safety, in the same transaction. */
export function teardownTimeline(db: DatabaseSync, removeNodes = false): void {
  transaction(db, () => {
    db.exec(`DELETE FROM summary_parents WHERE summary_id IN (SELECT summary_id FROM timeline_nodes);
      DELETE FROM summary_messages WHERE summary_id IN (SELECT summary_id FROM timeline_nodes);
      DELETE FROM context_items WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE is_timeline = 1);
      DELETE FROM timeline_memory_refs; DELETE FROM timeline_sources;
      UPDATE timeline_nodes SET active = 0, stale_reason = COALESCE(stale_reason, 'tracking-removed'), stale_since = COALESCE(stale_since, datetime('now'));
      DELETE FROM timeline_units; DELETE FROM timeline_items; DELETE FROM timeline_sessions; DELETE FROM timeline_months;
      DELETE FROM timeline_memory_dirty; DELETE FROM timeline_reconcile;
      UPDATE timeline_dirty SET dirty = 1;
      UPDATE timeline_state SET tracking = 0, generation = 0, phase = 'off', bootstrap_cursor = '', generator = NULL WHERE id = 1;`);
    if (removeNodes) removeTimelineNodes(db);
    dropTimelineTriggers(db);
  });
}

function removeTimelineNodes(db: DatabaseSync): void {
  const owned = "SELECT summary_id FROM summaries WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE is_timeline = 1)";
  db.exec(`DELETE FROM summary_parents WHERE summary_id IN (${owned}) OR parent_summary_id IN (${owned});
    DELETE FROM summary_messages WHERE summary_id IN (${owned});
    DELETE FROM context_items WHERE summary_id IN (${owned});
    DELETE FROM timeline_nodes;
    DELETE FROM summaries WHERE summary_id IN (${owned});`);
}

/** Explicit healing repairs missing triggers and re-seeds without resetting counters or generation. */
export function repairTimelineTracking(db: DatabaseSync): void {
  installTimelineTriggers(db);
  db.exec("UPDATE timeline_state SET phase = 'bootstrapping', bootstrap_cursor = '' WHERE tracking = 1");
}

/** Legacy units lack failure causes; give them one retry after provider admission. */
export function recoverTimelineAdmission(db: DatabaseSync): void {
  const state = db.prepare("SELECT admission_recovered FROM timeline_state WHERE id = 1").get() as { admission_recovered: number };
  if (state.admission_recovered) return;
  transaction(db, () => {
    db.exec("UPDATE timeline_units SET failures = 0, next_try = NULL, status = 'ready' WHERE failures > 0 AND (SELECT admission_recovered FROM timeline_state WHERE id = 1) = 0");
    db.exec("UPDATE timeline_state SET admission_recovered = 1 WHERE id = 1");
  });
}

/** Stores with an owner get the archive lookups indexed once, so each migration stays a point read. */
function indexTimelinePromotionLookups(db: DatabaseSync): void {
  for (const [name, column] of [["promoted_session_idx", "session_id"], ["promoted_source_summary_idx", "source_summary_id"]]) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
    if (!exists) db.exec(`CREATE INDEX ${name} ON promoted(${column})`);
  }
}

/** Timeline-derived promoted memories violate owner isolation, including after downgrade. */
function archiveTimelinePromotions(db: DatabaseSync): void {
  // Every request migrates. Without an owner there is nothing to archive, so a store that never
  // enabled the timeline pays one indexed point lookup; teardown --remove-nodes keeps the owner.
  if (!db.prepare("SELECT 1 FROM conversations WHERE is_timeline = 1").get()) return;
  indexTimelinePromotionLookups(db);
  const rows = db.prepare(`SELECT p.id, p.rowid FROM promoted p WHERE p.archived_at IS NULL
    AND (p.session_id = ? OR p.source_summary_id IN (
      SELECT s.summary_id FROM summaries s JOIN conversations c USING(conversation_id) WHERE c.is_timeline = 1))`)
    .all(TIMELINE_SESSION_ID) as Array<{ id: string; rowid: number }>;
  if (!rows.length) return;
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promoted_fts'").get();
  db.exec("SAVEPOINT timeline_archive_promoted");
  try {
    for (const row of rows) {
      db.prepare("UPDATE promoted SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(row.id);
      if (hasFts) db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
    }
    db.exec("RELEASE timeline_archive_promoted");
  } catch (error) {
    db.exec("ROLLBACK TO timeline_archive_promoted");
    db.exec("RELEASE timeline_archive_promoted");
    throw error;
  }
}
