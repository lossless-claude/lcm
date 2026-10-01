import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { enableTimeline, disableTimeline, teardownTimeline } from "../src/db/project-timeline.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";

const handles: DatabaseSync[] = [];
afterEach(() => { handles.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); handles.push(db); runLcmMigrations(db);
  const summarize = vi.fn(async () => "Scripted project history");
  const lease = <T>(work: Parameters<typeof withProjectMutation<T>>[1]) => withProjectMutation("incremental", work);
  return { db, summarize, timeline: openProjectTimeline(db, { summarize, lease }) };
}
function source(db: DatabaseSync, session = "session") {
  const id = Number(db.prepare("INSERT INTO conversations(session_id) VALUES (?)").run(session).lastInsertRowid);
  db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (?, 0, 'user', 'source', 10)").run(id);
  return id;
}
it("tracking off installs no triggers and adds no executed work to 100k inserts", () => {
  const { db } = fixture(); source(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").all()).toEqual([]);
  const before = (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
    INSERT INTO messages(conversation_id, seq, role, content, token_count) SELECT 1, n, 'user', 'source', 1 FROM seq`);
  expect((db.prepare("SELECT total_changes() n").get() as { n: number }).n - before).toBe(100000);
});
it("enable covers writes during bootstrap, disable retains tracking, teardown removes references before triggers", async () => {
  const { db, timeline, summarize } = fixture(); source(db);
  enableTimeline(db);
  expect(db.prepare("SELECT tracking, phase FROM timeline_state").get()).toMatchObject({ tracking: 1, phase: "bootstrapping" });
  db.exec("UPDATE messages SET content = 'between trigger creation and bootstrap'");
  const before = (db.prepare("SELECT rev FROM timeline_dirty WHERE session_id = 'session'").get() as { rev: number }).rev;
  await timeline.settle({ calls: 0 });
  expect(db.prepare("SELECT rev, dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ rev: before, dirty: 0 });
  await timeline.settle({ calls: 10 });
  disableTimeline(db); db.exec("UPDATE messages SET content = 'still tracked'");
  expect(db.prepare("SELECT tracking, generation FROM timeline_state").get()).toMatchObject({ tracking: 1, generation: 0 });
  await timeline.settle({ calls: 10 }); expect(summarize).toHaveBeenCalledTimes(2);
  teardownTimeline(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").all()).toEqual([]);
  expect(() => db.exec("DELETE FROM conversations WHERE is_timeline = 0")).not.toThrow();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("read-only unmigrated conversation reads do not require the owner column", async () => {
  const { db } = fixture(); source(db);
  db.exec("DROP INDEX timeline_owner_idx; DROP INDEX timeline_session_idx; ALTER TABLE conversations DROP COLUMN is_timeline");
  const store = new ConversationStore(db);
  expect(await store.getConversationBySessionId("session")).toMatchObject({ sessionId: "session" });
  expect(await store.listConversations()).toHaveLength(1);
  expect(await store.getMessageCount()).toBe(1);
});
it("a write to another session does not conflict with publication", async () => {
  const { db, timeline, summarize } = fixture(); source(db, "own"); enableTimeline(db);
  await timeline.settle({ calls: 0 });
  summarize.mockImplementationOnce(async () => { source(db, "unrelated"); return "Local unit result"; });
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ generated: 1, calls: 1 });
});

it("a counter conflict leaves its session dirty while settle applies the other session", async () => {
  const { db, summarize } = fixture();
  const changed = source(db, "a-conflicted"), stable = source(db, "b-ready");
  db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run("2026-01-01T00:00:00Z", changed);
  db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run("2026-02-01T00:00:00Z", stable);
  enableTimeline(db);
  let writeDuringLease = false;
  const timeline = openProjectTimeline(db, { summarize, lease: work => withProjectMutation("refresh-conflict", async lease => {
    if (writeDuringLease) {
      writeDuringLease = false;
      db.prepare("UPDATE messages SET content = 'written during lease wait' WHERE conversation_id = ?").run(changed);
    }
    return work(lease);
  }) });
  await timeline.settle({ calls: 0 });
  const before = db.prepare("SELECT * FROM timeline_items WHERE session_id = 'a-conflicted'").all();
  db.exec("UPDATE messages SET content = 'dirty source'");
  writeDuringLease = true;
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ generated: 1, calls: 1, dirty: 1, stopped: "budget" });
  expect(db.prepare("SELECT session_id, dirty FROM timeline_dirty ORDER BY session_id").all()).toEqual([
    { session_id: "a-conflicted", dirty: 1 }, { session_id: "b-ready", dirty: 0 },
  ]);
  expect(db.prepare("SELECT * FROM timeline_items WHERE session_id = 'a-conflicted'").all()).toEqual(before);
  expect(db.prepare("SELECT session_id FROM timeline_sources").all()).toEqual([{ session_id: "b-ready" }]);
  expect(await timeline.settle({ calls: 0 })).toMatchObject({ dirty: 0 });
});

it("reports conflict when no dirty session can be applied", async () => {
  const { db, summarize, timeline: initial } = fixture(); source(db); enableTimeline(db);
  await initial.settle({ calls: 0 });
  db.exec("UPDATE messages SET content = 'dirty'");
  const timeline = openProjectTimeline(db, { summarize, lease: work => withProjectMutation("only-conflict", async lease => {
    db.exec("UPDATE messages SET content = content || ' changed'");
    return work(lease);
  }) });
  expect(await timeline.settle({ calls: 0 })).toMatchObject({ calls: 0, dirty: 1, stopped: "conflict" });
});

it("a publication counter conflict does not stop an independent session unit", async () => {
  const { db, summarize, timeline } = fixture();
  const changed = source(db, "a-conflicted"), stable = source(db, "b-ready");
  db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run("2026-01-01T00:00:00Z", changed);
  db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run("2026-02-01T00:00:00Z", stable);
  enableTimeline(db);
  await timeline.settle({ calls: 0 });
  summarize.mockImplementationOnce(async () => {
    db.prepare("UPDATE messages SET content = 'written while generating' WHERE conversation_id = ?").run(changed);
    return "Obsolete";
  });
  expect(await timeline.settle({ calls: 2 })).toMatchObject({ calls: 2, generated: 1, dirty: 1, stopped: "budget" });
  expect(db.prepare("SELECT session_id FROM timeline_sources").all()).toEqual([{ session_id: "b-ready" }]);
});
it("covered message repair clears dirt without regenerating the unchanged frontier", async () => {
  const { db, timeline, summarize } = fixture(); source(db); enableTimeline(db);
  db.exec(`INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('leaf', 1, 'leaf', 'Covered', 10);
    INSERT INTO summary_messages VALUES ('leaf', 1, 0)`);
  await timeline.settle({ calls: 10 });
  expect(new ConversationStore(db).repairCutMessageContent([{ messageId: 1, storedContent: "source", content: "repaired covered text" }])).toBe(1);
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ calls: 0, pending: 0, stale: 0 });
  expect(summarize).toHaveBeenCalledTimes(1);
});

it("cold bootstrap reads a linear number of metadata rows", async () => {
  const measure = async (count: number) => {
    const { db, timeline } = fixture();
    for (let i = 0; i < count; i++) source(db, `session-${i}`);
    enableTimeline(db);
    const original = db.prepare.bind(db); let rows = 0;
    const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
      const stmt = original(sql); const all = stmt.all.bind(stmt);
      stmt.all = (...args) => { const result = all(...args); rows += result.length; return result; }; return stmt;
    });
    try { await timeline.settle({ calls: 0 }); return rows; } finally { spy.mockRestore(); }
  };
  const small = await measure(10), large = await measure(100);
  expect(large).toBeGreaterThan(small * 5); expect(large).toBeLessThan(small * 12);
});
it("settle source queries use the conversation/seq index without scanning summary_messages", async () => {
  const { db, timeline } = fixture(); source(db); enableTimeline(db);
  const original = db.prepare.bind(db); const plans: string[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const stmt = original(sql);
    if (/FROM messages m|FROM summaries s/.test(sql)) {
      const all = stmt.all.bind(stmt);
      stmt.all = (...args) => {
        plans.push(...(original(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(row => row.detail));
        return all(...args);
      };
    }
    return stmt;
  });
  try { await timeline.settle({ calls: 0 }); } finally { spy.mockRestore(); }
  expect(plans.some(plan => /messages_conv_seq_idx/.test(plan))).toBe(true);
  expect(plans.some(plan => /SCAN (?:sm|summary_messages)\b/.test(plan))).toBe(false);
});
it("publication takes one lease and does no source refresh or replan", async () => {
  const { db, summarize } = fixture(); source(db); enableTimeline(db);
  let leases = 0, afterGeneration = false, sourceReads = 0, plans = 0;
  const lease = <T>(work: Parameters<typeof withProjectMutation<T>>[1]) => { if (afterGeneration) leases++; return withProjectMutation("publish", work); };
  const timeline = openProjectTimeline(db, { lease, summarize: async (...args) => { const text = await summarize(...args); afterGeneration = true; return text; } });
  await timeline.settle({ calls: 0 });
  const original = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (afterGeneration && /FROM messages m|FROM timeline_items/.test(sql)) sourceReads++;
    if (afterGeneration && /INSERT INTO timeline_units/.test(sql)) plans++;
    return original(sql);
  });
  try { expect(await timeline.settle({ calls: 1 })).toMatchObject({ generated: 1 }); } finally { spy.mockRestore(); }
  expect(leases).toBe(1); expect(sourceReads).toBe(0); expect(plans).toBe(0);
});
it("model errors persist exponential backoff and park until a session changes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  const { db, timeline, summarize } = fixture(); source(db); enableTimeline(db);
  summarize.mockRejectedValue(new Error("scripted failure"));
  for (let failure = 1; failure <= 8; failure++) {
    expect(await timeline.settle({ calls: 1 })).toMatchObject({ calls: 1, stopped: "model-error" });
    const unit = db.prepare("SELECT failures, next_try, status FROM timeline_units").get() as { failures: number; next_try: string; status: string };
    expect(unit.failures).toBe(failure);
    expect(new Date(unit.next_try).getTime() - Date.now()).toBe(Math.min(3600000, 60000 * 2 ** (failure - 1)));
    expect(await timeline.settle({ calls: 1 })).toMatchObject({ calls: 0 });
    vi.setSystemTime(new Date(unit.next_try));
  }
  expect(db.prepare("SELECT status FROM timeline_units").get()).toMatchObject({ status: "parked" });
  db.exec("UPDATE messages SET content = 'new evidence'");
  summarize.mockResolvedValue("Recovered");
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ calls: 1, generated: 1 });
});

it("bootstrap pages preserve a write whose new session is behind the cursor", async () => {
  const { db, summarize } = fixture();
  for (let i = 0; i < 600; i++) source(db, `session-${String(i).padStart(3, "0")}`);
  enableTimeline(db); let bootstrapPages = 0;
  const timeline = openProjectTimeline(db, { summarize, lease: work => withProjectMutation("bootstrap-pages", async lease => {
    const before = db.prepare("SELECT bootstrap_cursor FROM timeline_state").get() as { bootstrap_cursor: string };
    const result = await work(lease);
    const after = db.prepare("SELECT bootstrap_cursor FROM timeline_state").get() as { bootstrap_cursor: string };
    if (after.bootstrap_cursor !== before.bootstrap_cursor) {
      bootstrapPages++;
      if (bootstrapPages === 1) source(db, "000-created-between-pages");
    }
    return result;
  }) });
  await timeline.settle({ calls: 0 });
  expect(bootstrapPages).toBe(3);
  expect(db.prepare("SELECT dirty, rev FROM timeline_dirty WHERE session_id = '000-created-between-pages'").get()).toMatchObject({ dirty: 0, rev: 2 });
  expect(db.prepare("SELECT COUNT(*) n FROM timeline_items").get()).toMatchObject({ n: 601 });
});
it("a conflict records the same persisted retry delay as a model failure", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  const { db, timeline, summarize } = fixture(); source(db); enableTimeline(db);
  summarize.mockImplementationOnce(async () => { db.exec("UPDATE messages SET content = 'changed during model wait'"); return "Obsolete"; });
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ stopped: "conflict", generated: 0 });
  expect(db.prepare("SELECT failures, next_try FROM timeline_units").get()).toMatchObject({ failures: 1, next_try: "2026-08-01T12:01:00.000Z" });
});

it("a new manual claim inside the unit invalidates an in-flight result", async () => {
  const { db, timeline, summarize } = fixture(); source(db); enableTimeline(db);
  db.exec("UPDATE messages SET created_at = '2026-08-01T12:00:00Z'");
  summarize.mockImplementationOnce(async () => {
    db.exec("INSERT INTO promoted(id, content, project_id, created_at) VALUES ('new-claim', 'New evidence', 'project', '2026-08-01T12:00:00Z')");
    return "Obsolete claim-free result";
  });
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ generated: 0, stopped: "conflict" });
});
it("explicit healing detects a changed claim whose tracking marker was lost", async () => {
  const { db, timeline } = fixture(); source(db); enableTimeline(db);
  db.exec(`UPDATE messages SET created_at = '2026-08-01T12:00:00Z';
    INSERT INTO promoted(id, content, project_id, created_at) VALUES ('claim', 'Old claim', 'project', '2026-08-01T12:00:00Z')`);
  await timeline.settle({ calls: 10 });
  db.exec(`UPDATE promoted SET content = 'Revised claim'; DELETE FROM timeline_memory_dirty;
    UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL`);
  expect(await timeline.settle({ calls: 0, reconcile: "full" })).toMatchObject({ stale: 2, pending: 1 });
});
