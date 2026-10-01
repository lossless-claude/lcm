import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { ensureTimelineOwner, enableTimeline, teardownTimeline } from "../src/db/project-timeline.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { clearConversationForRebuild } from "../src/claude-rebuild.js";

const handles: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(":memory:");
  handles.push(db);
  runLcmMigrations(db, { fts5Available: false });
  enableTimeline(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('session')");
  return db;
}
afterEach(() => handles.splice(0).forEach(db => db.close()));

it("ordinary message parts and context rewrites do not track source revisions", () => {
  const db = fixture();
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'source', 1)");
  const before = db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get();
  db.exec("INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal) VALUES ('text', 1, 'session', 'text', 0)");
  db.exec("INSERT INTO context_items(conversation_id, ordinal, item_type, message_id) VALUES (1, 0, 'message', 1); UPDATE context_items SET ordinal = 1; DELETE FROM context_items");
  expect(db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get()).toEqual(before);
});

it("doctor ignores historical timeline nodes when looking for orphan summaries", () => {
  const db = fixture();
  node(db);
  db.exec("DELETE FROM context_items; UPDATE timeline_nodes SET active = 0");
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('ordinary-orphan', 1, 'leaf', 'source', 1)");
  expect(new SummaryStore(db).getOrphanSummaryIds()).toEqual(["ordinary-orphan"]);
});

it("deleting a conversation detaches published dependencies before cascades", () => {
  const db = fixture();
  db.exec(`INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'source', 1);
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1);`);
  node(db);
  db.exec("INSERT INTO summary_parents VALUES ('timeline', 'source', 0); INSERT INTO summary_messages VALUES ('timeline', 1, 0)");
  expect(() => db.exec("DELETE FROM conversations WHERE conversation_id = 1")).not.toThrow();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT stale_reason FROM timeline_nodes").get()).toMatchObject({ stale_reason: "session-removed" });
  expect(db.prepare("SELECT content FROM summaries WHERE summary_id = 'timeline'").get()).toMatchObject({ content: "history" });
});

it("tracking records a source message in its transaction, including rollback", () => {
  const db = fixture();
  node(db);
  const before = db.prepare("SELECT * FROM timeline_dirty").all();
  db.exec("BEGIN");
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2)");
  expect(db.prepare("SELECT rev FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ rev: (before[0] as { rev: number }).rev + 1 });
  db.exec("ROLLBACK");
  expect(db.prepare("SELECT * FROM timeline_dirty").all()).toEqual(before);
});

function node(db: DatabaseSync) {
  const owner = ensureTimelineOwner(db);
  db.prepare("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('timeline', ?, 'condensed', 'history', 1)").run(owner);
  db.exec(`INSERT INTO timeline_nodes(summary_id, work_key, period_from, period_to, generator) VALUES ('timeline', 'key', '2026-01-01', '2026-01-02', 'v1');
    INSERT INTO timeline_sources(summary_id, conversation_id, session_id, revision, summary_ids, message_ids)
      VALUES ('timeline', 1, 'session', 'rev', '["source"]', '[1]');
    INSERT INTO context_items(conversation_id, ordinal, item_type, summary_id) VALUES (${owner}, 0, 'summary', 'timeline');`);
}

it.each([
  ["messages insert", "INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 2, 'user', 'more', 2)"],
  ["messages update", "UPDATE messages SET content = 'changed' WHERE message_id = 1"],
  ["messages delete", "DELETE FROM messages WHERE message_id = 1"],
  ["summaries insert", "INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('other', 1, 'leaf', 'new', 1)"],
  ["summaries update", "UPDATE summaries SET content = 'changed' WHERE summary_id = 'source'"],
  ["summaries delete", "DELETE FROM summaries WHERE summary_id = 'source'"],
  ["conversation update", "UPDATE conversations SET session_id = 'renamed' WHERE conversation_id = 1"],
])("%s tracks and flags dependents without editing their content", (label, sql) => {
  const db = fixture();
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2)");
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1)");
  if (label === "context update" || label === "context delete") {
    db.exec("INSERT INTO context_items(conversation_id, ordinal, item_type, message_id) VALUES (1, 0, 'message', 1)");
  }
  node(db);
  const before = (db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n;
  db.exec(sql);
  expect((db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n).toBeGreaterThan(before);
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
  expect(db.prepare("SELECT content FROM summaries WHERE summary_id = 'timeline'").get()).toMatchObject({ content: "history" });
});

it("the owner is unique and its writes do not track themselves", () => {
  const db = fixture();
  const before = db.prepare("SELECT * FROM timeline_dirty").all();
  expect(ensureTimelineOwner(db)).toBe(ensureTimelineOwner(db));
  node(db);
  expect(db.prepare("SELECT * FROM timeline_dirty").all()).toEqual(before);
});

it.each(["insert", "update", "delete"])("promoted memory %s tracks and flags its references", operation => {
  const db = fixture();
  node(db);
  db.exec("INSERT INTO timeline_memory_refs VALUES ('timeline', 'memory', 'revision')");
  if (operation !== "insert") db.exec("INSERT INTO promoted(id, content, project_id) VALUES ('memory', 'claim', 'project')");
  db.exec("UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL");
  const before = db.prepare("SELECT * FROM timeline_memory_dirty").all().length;
  db.exec("DELETE FROM timeline_memory_dirty");
  db.exec(operation === "insert" ? "INSERT INTO promoted(id, content, project_id) VALUES ('memory', 'claim', 'project')"
    : operation === "update" ? "UPDATE promoted SET archived_at = datetime('now') WHERE id = 'memory'"
    : "DELETE FROM promoted WHERE id = 'memory'");
  expect(db.prepare("SELECT * FROM timeline_memory_dirty").all()).toHaveLength(1);
  expect(db.prepare("SELECT stale_reason FROM timeline_nodes").get()).toMatchObject({ stale_reason: "memory-changed" });
});

it.each(["rebuild", "reset"])("%s detaches timeline summary and digest links and retains the historical node", async operation => {
  const db = fixture();
  db.exec(`INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2);
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1);`);
  node(db);
  db.exec("INSERT INTO summary_parents VALUES ('timeline', 'source', 0); INSERT INTO summary_messages VALUES ('timeline', 1, 0)");
  if (operation === "rebuild") {
    db.exec("BEGIN");
    clearConversationForRebuild(db, 1, "session");
    db.exec("COMMIT");
  } else await new SummaryStore(db, { fts5Available: false }).resetConversationContext(1);
  expect(db.prepare("SELECT * FROM summary_parents WHERE summary_id = 'timeline'").all()).toEqual([]);
  expect(db.prepare("SELECT content FROM summaries WHERE summary_id = 'timeline'").get()).toMatchObject({ content: "history" });
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["summary_parents", "summary_messages", "message_parts"])("%s lineage changes track insert, update and delete", table => {
  const db = fixture();
  db.exec(`INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2);
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1);
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('parent', 1, 'leaf', 'parent', 1);`);
  node(db);
  const insert = table === "summary_parents" ? "INSERT INTO summary_parents VALUES ('source', 'parent', 0)"
    : table === "summary_messages" ? "INSERT INTO summary_messages VALUES ('source', 1, 0)"
    : "INSERT INTO message_parts(part_id, message_id, session_id, part_type, ordinal) VALUES ('part', 1, 'session', 'compaction', 0)";
  for (const sql of [insert, table === "message_parts" ? "UPDATE message_parts SET part_type = 'text'" : `UPDATE ${table} SET ordinal = 1`, table === "message_parts" ? "UPDATE message_parts SET part_type = 'compaction'; DELETE FROM message_parts" : `DELETE FROM ${table}`]) {
    db.exec("UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL");
    const before = (db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n;
    db.exec(sql);
    expect((db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n).toBeGreaterThan(before);
    expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
  }
});

it("conversation creation and removal are recorded and removal keeps its manifest", () => {
  const db = fixture();
  const before = db.prepare("SELECT * FROM timeline_dirty").all().length;
  node(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('new-session')");
  expect(db.prepare("SELECT * FROM timeline_dirty").all()).toHaveLength(before + 1);
  db.exec("DELETE FROM conversations WHERE conversation_id = 1");
  expect(db.prepare("SELECT stale_reason FROM timeline_nodes").get()).toMatchObject({ stale_reason: "session-removed" });
  expect(db.prepare("SELECT session_id FROM timeline_sources").get()).toMatchObject({ session_id: "session" });
});

it("replay ordering changes track insert, update and delete", () => {
  const db = fixture();
  node(db);
  for (const sql of [
    "INSERT INTO replay_manifest(run_id, command, position, session_id) VALUES ('run', 'compact', 0, 'session')",
    "UPDATE replay_manifest SET position = 1",
    "DELETE FROM replay_manifest",
  ]) {
    const before = (db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n;
    db.exec(sql);
    expect((db.prepare("SELECT COALESCE(SUM(rev), 0) n FROM timeline_dirty").get() as { n: number }).n).toBe(before + 1);
  }
});

it("deleting a raw source detaches timeline digest links", () => {
  const db = fixture();
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2)");
  node(db);
  db.exec("INSERT INTO summary_messages VALUES ('timeline', 1, 0)");
  db.exec("DELETE FROM messages WHERE message_id = 1");
  expect(db.prepare("SELECT * FROM summary_messages").all()).toEqual([]);
  expect(db.prepare("SELECT content FROM summaries WHERE summary_id = 'timeline'").get()).toMatchObject({ content: "history" });
});

it("repeated migrations preserve nodes and install triggers once", () => {
  const db = fixture();
  node(db);
  runLcmMigrations(db, { fts5Available: false });
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'decision', 2)");
  expect(db.prepare("SELECT * FROM timeline_nodes").all()).toHaveLength(1);
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
});

it("migration restores missing tracking and detach triggers and replaces outdated SQL", () => {
  const db = fixture();
  db.exec(`INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'source', 1);
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1);`);
  node(db);
  db.exec("INSERT INTO summary_parents VALUES ('timeline', 'source', 0)");
  db.exec(`DROP TRIGGER timeline_messages_insert_new;
    DROP TRIGGER timeline_summaries_delete_old;
    DROP TRIGGER timeline_messages_update_new;
    CREATE TRIGGER timeline_messages_update_new AFTER UPDATE ON messages BEGIN SELECT 1; END;
    UPDATE timeline_dirty SET dirty = 0;`);
  runLcmMigrations(db, { fts5Available: false });
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%' ORDER BY name").all();
  expect(triggers).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "timeline_messages_insert_new" }),
    expect.objectContaining({ name: "timeline_summaries_delete_old" }),
  ]));
  db.exec("UPDATE messages SET content = 'edited' WHERE message_id = 1");
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
  expect(() => db.exec("DELETE FROM summaries WHERE summary_id = 'source'")).not.toThrow();
  expect(db.prepare("SELECT * FROM summary_parents").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  runLcmMigrations(db, { fts5Available: false });
  expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%' ORDER BY name").all()).toEqual(triggers);
});

it("a tracked ledger insert executes no timeline trigger that scans the replay manifest", () => {
  const db = fixture();
  db.exec("INSERT INTO replay_manifest(run_id, command, position, session_id) VALUES ('run', 'compact', 0, 'session')");
  const sql = "INSERT INTO replay_ledger(run_id, session_id, position, content_fingerprint) VALUES ('run', 'session', 0, 'done')";
  const program = db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: string; p4: string | null }>;
  expect(program.filter(row => row.opcode === "Init" && /-- TRIGGER timeline_/.test(row.p4 ?? ""))).toEqual([]);
  const before = (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  db.exec(sql);
  expect((db.prepare("SELECT total_changes() n").get() as { n: number }).n - before).toBe(1);
  expect((db.prepare("PRAGMA table_info(timeline_state)").all() as Array<{ name: string }>).map(row => row.name)).not.toContain("drain");
});

it("migration removes the legacy replay completion trigger and drain column", () => {
  const db = fixture();
  if (!(db.prepare("PRAGMA table_info(timeline_state)").all() as Array<{ name: string }>).some(row => row.name === "drain")) {
    db.exec("ALTER TABLE timeline_state ADD COLUMN drain INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`DROP TRIGGER IF EXISTS timeline_replay_complete;
    CREATE TRIGGER timeline_replay_complete AFTER INSERT ON replay_ledger
      BEGIN UPDATE timeline_state SET drain = 1 WHERE id = 1; END;`);
  runLcmMigrations(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'timeline_replay_complete'").get()).toBeUndefined();
  expect((db.prepare("PRAGMA table_info(timeline_state)").all() as Array<{ name: string }>).map(row => row.name)).not.toContain("drain");
});


it("migration drops legacy guarded triggers on an opted-out store", () => {
  const db = new DatabaseSync(":memory:"); handles.push(db); runLcmMigrations(db);
  db.exec("CREATE TRIGGER timeline_legacy AFTER INSERT ON messages WHEN 0 BEGIN SELECT 1; END");
  runLcmMigrations(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").all()).toEqual([]);
  for (const name of ["timeline_journal", "timeline_input_cache", "timeline_checkpoint"]) {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name)).toBeUndefined();
  }
});


it.each([false, true])("steady-state migration reads behind a writer and on a read-only store (tracking %s)", tracking => {
  const dir = mkdtempSync(join(process.cwd(), ".timeline-migration-"));
  const path = join(dir, "store.db");
  const writer = new DatabaseSync(path);
  let reader: DatabaseSync | undefined;
  try {
    writer.exec("PRAGMA journal_mode = WAL");
    runLcmMigrations(writer, { fts5Available: false });
    if (tracking) enableTimeline(writer);
    reader = new DatabaseSync(path);
    writer.exec("BEGIN IMMEDIATE");
    expect(() => runLcmMigrations(reader!, { fts5Available: false })).not.toThrow();
    reader.close();
    reader = new DatabaseSync(path, { readOnly: true });
    expect(() => runLcmMigrations(reader!, { fts5Available: false })).not.toThrow();
  } finally {
    reader?.close();
    if (writer.isTransaction) writer.exec("ROLLBACK");
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


it.each([0, 1])("a session summary consumed only by a timeline node stays orphaned (active %s)", active => {
  const db = fixture();
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1)");
  node(db);
  db.exec("INSERT INTO summary_parents VALUES ('timeline', 'source', 0)");
  db.prepare("UPDATE timeline_nodes SET active = ?").run(active);
  expect(new SummaryStore(db).getOrphanSummaryIds()).toEqual(["source"]);
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('session-consumer', 1, 'condensed', 'source', 1); INSERT INTO summary_parents VALUES ('session-consumer', 'source', 0)");
  expect(new SummaryStore(db).getOrphanSummaryIds()).toEqual(["session-consumer"]);
});


it("teardown can remove all owner summaries and timeline rows while keeping session sources", () => {
  const db = fixture();
  db.exec("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'source', 1); INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1); INSERT INTO summary_messages VALUES ('source', 1, 0)");
  node(db);
  const owner = ensureTimelineOwner(db);
  db.prepare("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('historical', ?, 'condensed', 'history', 1)").run(owner);
  db.exec("INSERT INTO summary_parents VALUES ('timeline', 'source', 0); INSERT INTO summary_parents VALUES ('historical', 'timeline', 0); INSERT INTO summary_messages VALUES ('timeline', 1, 0)");
  teardownTimeline(db, true);
  expect(db.prepare("SELECT summary_id FROM summaries ORDER BY summary_id").all()).toEqual([{ summary_id: "source" }]);
  expect(db.prepare("SELECT * FROM timeline_nodes").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM summary_parents").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM summary_messages").all()).toEqual([{ summary_id: "source", message_id: 1, ordinal: 0 }]);
  expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "source" }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("SELECT tracking, generation, phase FROM timeline_state").get()).toMatchObject({ tracking: 0, generation: 0, phase: "off" });
});


it.each([false, true])("migration archives only timeline-derived promoted memories (tracking %s)", tracking => {
  const db = fixture();
  node(db);
  if (!tracking) teardownTimeline(db);
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'source', 1)");
  db.exec(`INSERT INTO promoted(id, content, project_id, session_id, source_summary_id) VALUES
    ('by-source', 'timeline claim', 'project', 'other', 'timeline'),
    ('by-session', 'timeline claim', 'project', 'lcm:project-timeline', 'removed-node'),
    ('ordinary', 'session claim', 'project', 'session', 'source'),
    ('manual', 'manual claim', 'project', 'manual', NULL);
    INSERT INTO promoted(id, content, project_id, session_id, archived_at) VALUES
    ('already-archived', 'timeline claim', 'project', 'lcm:project-timeline', '2026-01-01 00:00:00');`);
  runLcmMigrations(db, { fts5Available: false });
  expect(db.prepare("SELECT id FROM promoted WHERE archived_at IS NULL ORDER BY id").all()).toEqual([{ id: 'manual' }, { id: 'ordinary' }]);
  expect(db.prepare("SELECT archived_at FROM promoted WHERE id = 'already-archived'").get()).toMatchObject({ archived_at: '2026-01-01 00:00:00' });
  const archived = db.prepare("SELECT id, archived_at FROM promoted ORDER BY id").all();
  const changes = db.prepare("SELECT total_changes() n").get();
  runLcmMigrations(db, { fts5Available: false });
  expect(db.prepare("SELECT id, archived_at FROM promoted ORDER BY id").all()).toEqual(archived);
  expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
});

it("archived timeline memories leave full-text search after a re-upgrade", () => {
  const db = new DatabaseSync(":memory:");
  handles.push(db);
  runLcmMigrations(db, { fts5Available: true });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promoted_fts'").get()) return;
  enableTimeline(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('session')");
  node(db);
  db.exec(`INSERT INTO promoted(id, content, project_id, session_id, source_summary_id) VALUES
    ('derived', 'zirconium timeline claim', 'project', 'lcm:project-timeline', 'timeline'),
    ('ordinary', 'zirconium session claim', 'project', 'session', NULL);
    INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, content, tags FROM promoted;`);
  const matches = () => (db.prepare("SELECT p.id FROM promoted_fts f JOIN promoted p ON p.rowid = f.rowid WHERE promoted_fts MATCH 'zirconium' ORDER BY p.id").all() as Array<{ id: string }>).map(row => row.id);
  expect(matches()).toEqual(["derived", "ordinary"]);
  runLcmMigrations(db, { fts5Available: true });
  expect(matches()).toEqual(["ordinary"]);
});
