import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";
import { ensureTimelineOwner, enableTimeline, TIMELINE_SESSION_ID } from "../src/db/project-timeline.js";
import { SessionCapture } from "../src/capture.js";
import { ScrubEngine } from "../src/scrub.js";
import { searchNativeHistory } from "../src/search/native-history.js";
import { PromotedStore } from "../src/db/promoted.js";

const handles: DatabaseSync[] = [];


it("a model failure preserves the stale reason of the exact failed digest unit", async () => {
  const { db, timeline, summarize } = fixture();
  vi.stubEnv("LCM_LEAF_CHUNK_TOKENS", "10");
  const id = raw(db, "session", "2026-08-01T12:00:00Z");
  db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (?, 1, 'user', 'second chunk', 10, '2026-08-01T13:00:00Z')").run(id);
  await timeline.settle({ calls: 10 });
  const old = nodes(db).filter(node => timeline.describe(node.summary_id)!.coverage[0].messageRange?.[0] === 1)[0].summary_id;
  db.prepare("UPDATE messages SET content = content || ' revised' WHERE conversation_id = ?").run(id);
  summarize.mockResolvedValueOnce("Updated first digest").mockRejectedValueOnce(new Error("scripted failure"));
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 1, stopped: "model-error" });
  expect(timeline.describe(old)!.stale!.reason).toBe("session-changed");
  const fresh = db.prepare("SELECT summary_id FROM timeline_nodes WHERE active = 1 AND stale_reason IS NULL AND level = 'digest'").all() as Array<{ summary_id: string }>;
  expect(fresh).toHaveLength(1);
});

it("retires a raw digest when a later session summary covers its messages", async () => {
  const { db, timeline } = fixture();
  const id = raw(db, "session", "2026-08-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  const digest = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'digest'").get() as { summary_id: string };
  const oldPeriod = nodes(db).at(-1)!.summary_id;
  const summaries = new SummaryStore(db);
  await summaries.insertSummary({ summaryId: "later-summary", conversationId: id, kind: "leaf", content: "A later summary", tokenCount: 10 });
  await summaries.linkSummaryToMessages("later-summary", [1]);
  await timeline.settle({ calls: 10 });
  expect(db.prepare("SELECT active FROM timeline_nodes WHERE summary_id = ?").get(digest.summary_id)).toMatchObject({ active: 0 });
  expect(summaries.getSummarySync(digest.summary_id)!.content).toBe("A cited project history.");
  expect(db.prepare("SELECT active FROM timeline_nodes WHERE summary_id = ?").get(oldPeriod)).toMatchObject({ active: 0 });
  const context = await summaries.getContextItems(ensureTimelineOwner(db));
  expect(context).toHaveLength(1);
  expect(timeline.describe(context[0].summaryId!)!.replaces).toContain(oldPeriod);
});

it("settle reads source content outside the lease in bounded batches, including full reconciliation", async () => {
  const { db, summarize, deps } = fixture();
  const id = raw(db, "large", "2026-08-01T12:00:00Z");
  const insert = db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (?, ?, 'user', 'source', 1, '2026-08-01T12:00:00Z')");
  for (let seq = 1; seq < 600; seq++) insert.run(id, seq);
  let leased = false;
  let leaseReads = 0;
  let largestBatch = 0;
  const original = db.prepare.bind(db);
  const prepare = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = original(sql);
    if (/SELECT[\s\S]*FROM (?:messages|summaries)\b/i.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        largestBatch = Math.max(largestBatch, rows.length);
        if (leased) leaseReads += rows.length;
        return rows;
      };
    }
    return statement;
  });
  const timeline = openProjectTimeline(db, { summarize, lease: work => deps.lease(async lease => {
    leased = true;
    try { return await work(lease); } finally { leased = false; }
  }) });
  try {
    let yielded = false;
    setImmediate(() => { yielded = true; });
    await timeline.settle({ calls: 0, reconcile: "full" });
    expect(leaseReads).toBe(0);
    expect(largestBatch).toBeLessThanOrEqual(256);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'timeline_input_cache_batches'").get()).toBeUndefined();
    expect(yielded).toBe(true);
    leaseReads = 0;
    await timeline.settle({ calls: 2 });
    expect(leaseReads).toBe(0);
  } finally { prepare.mockRestore(); }
});

it("settle refreshes only dirty sessions after reopen", async () => {
  const { db, timeline, deps } = fixture();
  const changed = raw(db, "changed", "2026-08-01T12:00:00Z");
  raw(db, "untouched", "2026-09-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  expect(db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get()).toMatchObject({ n: 0 });
  db.prepare("UPDATE messages SET content = 'changed' WHERE conversation_id = ?").run(changed);
  const original = db.prepare.bind(db);
  const readConversations: unknown[] = [];
  const prepare = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = original(sql);
    if (/FROM messages m[\s\S]*m.conversation_id = \?/i.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => { readConversations.push(args[0]); return all(...args); };
    }
    return statement;
  });
  try {
    await openProjectTimeline(db, deps).settle({ calls: 0 });
    expect(readConversations).not.toContain(2);
    expect(readConversations).toContain(changed);
    expect(db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get()).toMatchObject({ n: 0 });
  } finally { prepare.mockRestore(); }
});


it("a failed second digest chunk leaves the successful sibling fresh", async () => {
  const { db, summarize, timeline } = fixture();
  vi.stubEnv("LCM_LEAF_CHUNK_TOKENS", "10");
  const id = raw(db, "session", "2026-08-01T12:00:00Z");
  db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (?, 1, 'user', 'second chunk', 10, '2026-08-01T13:00:00Z')").run(id);
  summarize.mockResolvedValueOnce("First digest").mockRejectedValueOnce(new Error("scripted failure"));
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ calls: 2, generated: 1, stopped: "model-error" });
  expect(timeline.describe(nodes(db)[0].summary_id)!.stale).toBeNull();
});

it("manual attribution repair preserves fresh timeline claims and their revision", async () => {
  const { db, timeline } = fixture();
  raw(db, "a", "2026-08-01T12:00:00Z"); raw(db, "b", "2026-08-03T12:00:00Z");
  db.exec("INSERT INTO promoted(id, content, project_id, session_id, created_at) VALUES ('memory', 'Claim', 'project', 'manual', '2026-08-02T12:00:00Z')");
  await timeline.settle({ calls: 10 });
  const old = nodes(db).at(-1)!.summary_id;
  const refs = timeline.describe(old)!.memoryRefs;
  expect(new PromotedStore(db).attributeManual("memory", "a")).toBe(true);
  expect(timeline.describe(old)!.stale).toBeNull();
  expect(await timeline.settle({ calls: 0, reconcile: "full" })).toMatchObject({ stale: 0, pending: 0 });
  expect(timeline.describe(old)!.memoryRefs).toEqual(refs);
});
afterEach(() => { handles.splice(0).forEach(db => db.close()); vi.unstubAllEnvs(); });
function fixture() {
  const db = new DatabaseSync(":memory:");
  handles.push(db);
  runLcmMigrations(db);
  enableTimeline(db);
  const summarize = vi.fn(async () => "A cited project history.");
  const deps = { summarize, lease: <T>(work: Parameters<typeof withProjectMutation<T>>[1]) => withProjectMutation("timeline-test", work) };
  return { db, summarize, deps, timeline: openProjectTimeline(db, deps) };
}
function raw(db: DatabaseSync, session: string, date: string, content = "We chose SQLite.") {
  const id = Number(db.prepare("INSERT INTO conversations(session_id) VALUES (?)").run(session).lastInsertRowid);
  db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (?, 0, 'user', ?, 10, ?)")
    .run(id, content, date);
  return id;
}
function nodes(db: DatabaseSync) {
  return db.prepare("SELECT summary_id FROM timeline_nodes WHERE active = 1 ORDER BY rowid").all() as Array<{ summary_id: string }>;
}

it("covers consecutive small unsummarized sessions with an expandable digest and period", async () => {
  const { db, timeline, summarize } = fixture();
  raw(db, "a", "2026-08-01T12:00:00Z");
  raw(db, "b", "2026-08-02T12:00:00Z", "We kept transactions.");
  const status = await timeline.settle({ calls: 0 });
  expect(status).toMatchObject({ calls: 0, generated: 0, pending: 1, stopped: "budget" });
  expect(summarize).not.toHaveBeenCalled();
  const report = await timeline.settle({ calls: 10 });
  expect(report).toMatchObject({ generated: 2, calls: 2, pending: 0, stopped: "complete" });
  const period = nodes(db).at(-1)!.summary_id;
  expect(timeline.describe(period)).toMatchObject({
    period: { from: "2026-08-01T12:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
    coverage: [{ sessionId: "a", summaryIds: [], messageRange: [0, 0] }, { sessionId: "b", summaryIds: [], messageRange: [0, 0] }],
    stale: null,
  });
  const digest = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'digest'").get() as { summary_id: string };
  expect((await new SummaryStore(db).getSummaryParents(period)).map(summary => summary.summaryId)).toEqual([digest.summary_id]);
  expect((await new SummaryStore(db).getSummaryMessages(digest.summary_id)).length).toBe(2);
  const described = await new RetrievalEngine(new ConversationStore(db), new SummaryStore(db)).describe(period);
  expect(described!.summary!.sourceMessageTokenCount).toBe(20);
  expect(described!.summary!.descendantTokenCount).toBeGreaterThan(0);
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ calls: 0, generated: 0, pending: 0 });
  expect(timeline.describe("not-timeline")).toBeNull();
});

it("digest batches stop at an intervening summarized session", async () => {
  const { db, timeline } = fixture();
  raw(db, "a", "2026-08-01T12:00:00Z");
  const middle = raw(db, "middle", "2026-08-02T12:00:00Z");
  await new SummaryStore(db).insertSummary({ summaryId: "sum_middle", conversationId: middle, kind: "leaf", content: "A summarized session", tokenCount: 10,
    earliestAt: new Date("2026-08-02T12:00:00Z"), latestAt: new Date("2026-08-02T12:00:00Z") });
  await new SummaryStore(db).linkSummaryToMessages("sum_middle", [2]);
  raw(db, "b", "2026-08-03T12:00:00Z");
  await timeline.settle({ calls: 10 });
  const leaves = db.prepare("SELECT summary_id FROM summaries WHERE kind = 'leaf' AND conversation_id <> ?").all(middle) as Array<{ summary_id: string }>;
  expect(leaves).toHaveLength(2);
  const period = nodes(db).at(-1)!.summary_id;
  expect(timeline.describe(period)!.coverage.find(source => source.sessionId === "middle")!.summaryIds).toEqual(["sum_middle"]);
});

it("releases the mutation lease during generation and rejects a changed source", async () => {
  const { db, timeline, summarize } = fixture();
  const conversation = raw(db, "session", "2026-08-01T12:00:00Z");
  summarize.mockImplementationOnce(async () => {
    await withProjectMutation("timeline-test", async () => {
      db.prepare("INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (?, 1, 'user', 'changed', 10, '2026-08-01T13:00:00Z')").run(conversation);
    });
    return "Obsolete result";
  });
  expect(await timeline.settle({ calls: 5 })).toMatchObject({ generated: 0, calls: 1, pending: 1, stopped: "conflict" });
  expect(nodes(db)).toEqual([]);
});

it("continues independent work after a conflict", async () => {
  const { db, timeline, summarize } = fixture();
  const first = raw(db, "a", "2026-08-01T12:00:00Z");
  raw(db, "b", "2026-09-01T12:00:00Z");
  summarize.mockImplementationOnce(async () => {
    db.prepare("UPDATE messages SET content = 'changed' WHERE conversation_id = ?").run(first);
    return "Obsolete result";
  });
  const report = await timeline.settle({ calls: 10 });
  expect(report).toMatchObject({ generated: 2, calls: 3, dirty: 1, stopped: "complete" });
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 2, dirty: 0 });
});

it("resumes at its durable checkpoint after a budget interruption without re-running digest generation", async () => {
  const { db, timeline, summarize, deps } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  expect(await timeline.settle({ calls: 1 })).toMatchObject({ generated: 1, calls: 1, pending: 1, stopped: "budget" });
  expect(db.prepare("SELECT published FROM timeline_state").get()).toMatchObject({ published: 1 });
  expect(await openProjectTimeline(db, deps).settle({ calls: 1 })).toMatchObject({ generated: 1, calls: 1, pending: 0, stopped: "complete" });
  expect(summarize.mock.calls).toHaveLength(2);
  expect(db.prepare("SELECT published FROM timeline_state").get()).toMatchObject({ published: 2 });
  expect(db.prepare("SELECT * FROM replay_ledger").all()).toEqual([]);
});

it("closes chunks at UTC month boundaries and accepts summaries at different depths", async () => {
  const { db, timeline } = fixture();
  const a = raw(db, "a", "2026-08-31T23:59:59Z");
  const b = raw(db, "b", "2026-09-01T00:00:00Z");
  for (const [index, conversation, depth, date] of [[0, a, 0, "2026-08-31T23:59:59Z"], [1, b, 3, "2026-09-01T00:00:00Z"]] as const) {
    await new SummaryStore(db).insertSummary({ summaryId: `sum_${index}`, conversationId: conversation, kind: "condensed", depth, content: "Source", tokenCount: 10,
      earliestAt: new Date("2026-08-01T00:00:00Z"), latestAt: new Date(date) });
    await new SummaryStore(db).linkSummaryToMessages(`sum_${index}`, [index + 1]);
  }
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 2, calls: 2, stopped: "complete" });
  expect(nodes(db).map(node => timeline.describe(node.summary_id)!.period.to)).toEqual(["2026-08-31T23:59:59.000Z", "2026-09-01T00:00:00.000Z"]);
});

it("uses replay-manifest order with actual coverage bounds", async () => {
  const { db, timeline, summarize } = fixture();
  raw(db, "first", "2026-08-20T12:00:00Z", "first in replay");
  raw(db, "second", "2026-08-01T12:00:00Z", "second in replay");
  db.exec("INSERT INTO replay_manifest(run_id, command, position, session_id) VALUES ('run', 'compact', 0, 'first'), ('run', 'compact', 1, 'second')");
  await timeline.settle({ calls: 10 });
  const prompt = summarize.mock.calls[0][0] as string;
  expect(prompt.indexOf("first in replay")).toBeLessThan(prompt.indexOf("second in replay"));
  expect(timeline.describe(nodes(db).at(-1)!.summary_id)!.period).toEqual({ from: "2026-08-01T12:00:00.000Z", to: "2026-08-20T12:00:00.000Z" });
});

it("full reconciliation heals a missed journal entry and publishes immutable replacements", async () => {
  const { db, timeline } = fixture();
  const id = raw(db, "session", "2026-08-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  const old = nodes(db).at(-1)!.summary_id;
  db.prepare("UPDATE messages SET content = 'A revised decision' WHERE conversation_id = ?").run(id);
  db.exec("UPDATE timeline_dirty SET dirty = 0; UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL");
  expect(await timeline.settle({ calls: 0, reconcile: "full" })).toMatchObject({ calls: 0, stale: 2, pending: 1 });
  expect(timeline.describe(old)!.stale!.reason).toBe("session-changed");
  await timeline.settle({ calls: 10 });
  const replacement = nodes(db).at(-1)!.summary_id;
  expect(timeline.describe(replacement)!.replaces).toContain(old);
  expect(new SummaryStore(db).getSummarySync(old)!.content).toBe("A cited project history.");
});

it("keeps attributed claims separate and flags correction and archival", async () => {
  const { db, timeline, summarize } = fixture();
  raw(db, "a", "2026-08-01T12:00:00Z");
  raw(db, "b", "2026-08-03T12:00:00Z");
  db.exec("INSERT INTO promoted(id, content, tags, project_id, created_at) VALUES ('memory', 'Use a different database.', '[\"type:decision\"]', 'project', '2026-08-02T12:00:00Z')");
  await timeline.settle({ calls: 10 });
  const old = nodes(db).at(-1)!.summary_id;
  const ref = timeline.describe(old)!.memoryRefs[0];
  expect(ref.memoryId).toBe("memory");
  expect(summarize.mock.calls[0][0]).toContain("ATTRIBUTED CLAIMS");
  expect(summarize.mock.calls[0][0]).toContain("Use a different database.");
  const context = summarize.mock.calls[0][2];
  expect(context?.previousSummary).toBeUndefined();
  expect(context?.taskPrompt).toContain("State disagreements");
  db.exec("UPDATE promoted SET content = 'Use SQLite instead.' WHERE id = 'memory'");
  expect(timeline.describe(old)!.stale!.reason).toBe("memory-changed");
  await timeline.settle({ calls: 10 });
  const current = nodes(db).at(-1)!.summary_id;
  expect(timeline.describe(current)!.memoryRefs[0].revision).not.toBe(ref.revision);
  db.exec("UPDATE promoted SET archived_at = datetime('now') WHERE id = 'memory'");
  expect(timeline.describe(current)!.stale!.reason).toBe("memory-changed");
  await timeline.settle({ calls: 10 });
  expect(timeline.describe(nodes(db).at(-1)!.summary_id)!.memoryRefs).toEqual([]);
});

it("counts failed calls, leaves work pending and resumes without repeating a successful digest", async () => {
  const { db, timeline, summarize, deps } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  summarize.mockResolvedValueOnce("Digest").mockRejectedValueOnce(new Error("scripted outage"));
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 1, calls: 2, pending: 1, stopped: "model-error", failed: [{ reason: "timeline generation failed" }] });
  db.exec("UPDATE timeline_units SET next_try = NULL");
  expect(await openProjectTimeline(db, deps).settle({ calls: 1 })).toMatchObject({ generated: 1, calls: 1, pending: 0, stopped: "complete" });
});

it("does not call the model after a deadline", async () => {
  const { db, summarize, deps } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  const timeline = openProjectTimeline(db, { ...deps, now: () => new Date("2026-08-10T00:00:00Z") });
  expect(await timeline.settle({ calls: 10, deadline: new Date("2026-08-09T00:00:00Z") })).toMatchObject({ calls: 0, generated: 0, stopped: "deadline" });
  expect(summarize).not.toHaveBeenCalled();
});

it("does not publish a result returned after the deadline", async () => {
  const { db, summarize, deps } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  let date = new Date("2026-08-10T00:00:00Z");
  summarize.mockImplementationOnce(async () => { date = new Date("2026-08-12T00:00:00Z"); return "Late result"; });
  const timeline = openProjectTimeline(db, { ...deps, now: () => date });
  expect(await timeline.settle({ calls: 10, deadline: new Date("2026-08-11T00:00:00Z") })).toMatchObject({ generated: 0, calls: 1, stopped: "deadline" });
  expect(nodes(db)).toEqual([]);
});

it("a changed generator invalidates nodes and depth differences do not close period chunks", async () => {
  const { db, timeline } = fixture();
  const a = raw(db, "a", "2026-08-01T12:00:00Z");
  const b = raw(db, "b", "2026-08-02T12:00:00Z");
  for (const [index, conversation, depth] of [[0, a, 0], [1, b, 3]] as const) {
    await new SummaryStore(db).insertSummary({ summaryId: `sum_${index}`, conversationId: conversation, kind: "condensed", depth, content: "Source", tokenCount: 10 });
    await new SummaryStore(db).linkSummaryToMessages(`sum_${index}`, [index + 1]);
  }
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 1, calls: 1 });
  const old = nodes(db)[0].summary_id;
  vi.stubEnv("LCM_LEAF_CHUNK_TOKENS", "15");
  expect(await timeline.settle({ calls: 0 })).toMatchObject({ stale: 1, pending: 2 });
  expect(timeline.describe(old)!.stale!.reason).toBe("generator-changed");
});

it("excludes the owner from capture, restore fallback, promotion enumeration and session summary counts", async () => {
  const { db, timeline } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  const store = new ConversationStore(db);
  expect((await store.listConversations()).map(conversation => conversation.sessionId)).toEqual(["session"]);
  expect((await store.latestActiveConversation("new-session"))!.sessionId).toBe("session");
  expect(await store.getConversationBySessionId(TIMELINE_SESSION_ID)).toBeNull();
  expect(await new SummaryStore(db).countSummaries()).toBe(0);
  const capture = new SessionCapture(db, "project", new ScrubEngine([], []));
  expect((await capture.write({ sessionId: TIMELINE_SESSION_ID, messages: [{ role: "user", content: "forbidden", timestamp: new Date().toISOString() }] })).records).toEqual([]);
  expect(await store.getMessageCount(ensureTimelineOwner(db))).toBe(0);
});

it("search hides stale timeline nodes and explicitly includes them with periods and reasons", async () => {
  const { db, timeline } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  const input = { query: "cited project history", limit: 10, project: { id: "project", cwd: "project" } };
  const fresh = await searchNativeHistory(db, input);
  expect(fresh.some(hit => hit.timeline?.period.from === "2026-08-01T12:00:00.000Z")).toBe(true);
  db.exec("UPDATE messages SET content = 'Changed source'");
  await timeline.settle({ calls: 0 });
  expect((await searchNativeHistory(db, input)).filter(hit => hit.timeline)).toEqual([]);
  const stale = (await searchNativeHistory(db, { ...input, includeStale: true })).filter(hit => hit.timeline);
  expect(stale).toHaveLength(2);
  expect(stale.every(hit => hit.timeline!.stale!.reason === "session-changed")).toBe(true);
});

it("memory confidence changes do not invalidate claim revisions", async () => {
  const { db, timeline } = fixture();
  raw(db, "a", "2026-08-01T12:00:00Z"); raw(db, "b", "2026-08-03T12:00:00Z");
  db.exec("INSERT INTO promoted(id, content, project_id, created_at) VALUES ('memory', 'Claim', 'project', '2026-08-02T12:00:00Z')");
  await timeline.settle({ calls: 10 });
  const old = nodes(db).at(-1)!.summary_id;
  db.exec("UPDATE promoted SET confidence = 0.5; UPDATE timeline_dirty SET dirty = 0; UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL");
  await timeline.settle({ calls: 0, reconcile: "full" });
  expect(timeline.describe(old)!.stale).toBeNull();
});

it("full reconciliation distinguishes an emptied conversation from a removed session", async () => {
  const { db, timeline } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z"); await timeline.settle({ calls: 10 });
  const old = nodes(db).at(-1)!.summary_id;
  db.exec("DELETE FROM messages; UPDATE timeline_dirty SET dirty = 0; UPDATE timeline_nodes SET stale_reason = NULL, stale_since = NULL");
  await timeline.settle({ calls: 0, reconcile: "full" });
  expect(timeline.describe(old)!.stale!.reason).toBe("session-changed");
});

it("rejects a source DAG revision change during generation even when the frontier row is unchanged", async () => {
  const { db, timeline, summarize } = fixture();
  const id = raw(db, "session", "2026-08-01T12:00:00Z");
  const store = new SummaryStore(db);
  await store.insertSummary({ summaryId: "leaf", conversationId: id, kind: "leaf", content: "Original", tokenCount: 10 });
  await store.linkSummaryToMessages("leaf", [1]);
  await store.insertSummary({ summaryId: "frontier", conversationId: id, kind: "condensed", content: "Frontier", tokenCount: 10 });
  await store.linkSummaryToParents("frontier", ["leaf"]);
  summarize.mockImplementationOnce(async () => { db.exec("UPDATE summaries SET content = 'Revised' WHERE summary_id = 'leaf'"); return "Obsolete result"; });
  expect(await timeline.settle({ calls: 10 })).toMatchObject({ generated: 0, calls: 1, stopped: "conflict" });
  expect(nodes(db)).toEqual([]);
});

it("keeps the timeline context chronological when replacing an older period", async () => {
  const { db, timeline } = fixture();
  const first = raw(db, "a", "2026-08-01T12:00:00Z"); raw(db, "b", "2026-09-01T12:00:00Z");
  await timeline.settle({ calls: 10 });
  db.prepare("UPDATE messages SET content = 'Changed' WHERE conversation_id = ?").run(first);
  await timeline.settle({ calls: 10 });
  const store = new SummaryStore(db);
  const context = await store.getContextItems(ensureTimelineOwner(db));
  expect(context.map(item => store.getSummarySync(item.summaryId!)!.latestAt!.toISOString())).toEqual([
    "2026-08-01T12:00:00.000Z", "2026-09-01T12:00:00.000Z",
  ]);
});

it("describes raw coverage across both sides of a clear with session-relative positions", async () => {
  const { db, timeline } = fixture();
  const capture = new SessionCapture(db, "project", new ScrubEngine([], []));
  await capture.write({ sessionId: "omp-session", messages: [
    { role: "user", content: "Before the clear", tokenCount: 10, timestamp: "2026-08-01T12:00:00Z" },
    { role: "user", content: "After the clear", tokenCount: 10, timestamp: "2026-08-02T12:00:00Z" },
  ], boundaries: [{ entryId: "clear", at: 1 }] });
  await timeline.settle({ calls: 10 });
  expect(timeline.describe(nodes(db).at(-1)!.summary_id)!.coverage).toEqual([
    { sessionId: "omp-session", summaryIds: [], messageRange: [0, 0], timeBasis: "capture" },
    { sessionId: "omp-session", summaryIds: [], messageRange: [1, 1], timeBasis: "capture" },
  ]);
});

it("does not clear dirt when persisting the refreshed session fails", async () => {
  const { db, timeline } = fixture(); raw(db, "session", "2026-08-01T12:00:00Z"); await timeline.settle({ calls: 10 });
  db.exec("UPDATE messages SET content = 'Changed source'");
  const before = db.prepare("SELECT rev, dirty FROM timeline_dirty").all();
  db.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON timeline_items BEGIN SELECT RAISE(ABORT, 'scripted refresh failure'); END");
  await expect(timeline.settle({ calls: 0 })).rejects.toThrow("scripted refresh failure");
  expect(db.prepare("SELECT rev, dirty FROM timeline_dirty").all()).toEqual(before);
  db.exec("DROP TRIGGER reject_refresh");
  expect(await timeline.settle({ calls: 0 })).toMatchObject({ pending: 1, calls: 0 });
});


it("settles an earlier complete period before a later pending digest", async () => {
  const { db, timeline } = fixture();
  const id = raw(db, "a", "2026-08-01T12:00:00Z");
  await new SummaryStore(db).insertSummary({ summaryId: "august", conversationId: id, kind: "leaf", content: "August decision", tokenCount: 10,
    earliestAt: new Date("2026-08-01T12:00:00Z"), latestAt: new Date("2026-08-01T12:00:00Z") });
  await new SummaryStore(db).linkSummaryToMessages("august", [1]);
  raw(db, "b", "2026-09-01T12:00:00Z");
  await timeline.settle({ calls: 1 });
  expect(timeline.describe(nodes(db)[0].summary_id)!.period.to).toBe("2026-08-01T12:00:00.000Z");
});

it("does not interleave another writer or roll its source deletion back during publication", async () => {
  const { db, timeline } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  db.function("schedule_source_delete", () => {
    queueMicrotask(() => db.exec("DELETE FROM messages WHERE message_id = 1"));
    return 0;
  });
  db.exec(`CREATE TRIGGER schedule_after_timeline_insert AFTER INSERT ON summaries
    WHEN NEW.conversation_id IN (SELECT conversation_id FROM conversations WHERE is_timeline = 1)
    BEGIN SELECT schedule_source_delete(); END`);
  await expect(timeline.settle({ calls: 1 })).resolves.toMatchObject({ generated: 1 });
  expect(await new ConversationStore(db).getMessageCount()).toBe(0);
  const historical = db.prepare("SELECT summary_id FROM timeline_nodes").get() as { summary_id: string };
  expect(timeline.describe(historical.summary_id)!.stale!.reason).toBe("session-changed");
});


it("bootstrap rejects a source change during a yielded read using its write counter", async () => {
  const { db, timeline, summarize } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  const original = db.prepare.bind(db);
  let scheduled = false;
  const prepare = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = original(sql);
    if (!scheduled && sql.includes("FROM messages m")) {
      scheduled = true;
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        setImmediate(() => db.exec("UPDATE messages SET content = 'Changed during bootstrap'"));
        return rows;
      };
    }
    return statement;
  });
  try {
    expect(await timeline.settle({ calls: 0 })).toMatchObject({ calls: 0, generated: 0, stopped: "conflict" });
    expect(summarize).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get()).toMatchObject({ n: 1 });
    expect(await timeline.settle({ calls: 2 })).toMatchObject({ generated: 2, stopped: "complete" });
    expect(summarize.mock.calls[0][0]).toContain("Changed during bootstrap");
  } finally { prepare.mockRestore(); }
});


it("refreshes bootstrap sources between zero-call planning and generation", async () => {
  const { db, timeline, summarize } = fixture();
  raw(db, "session", "2026-08-01T12:00:00Z");
  await timeline.settle({ calls: 0 });
  db.exec("UPDATE messages SET content = 'Revised before the first node'");
  expect(db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get()).toMatchObject({ n: 1 });
  await timeline.settle({ calls: 2 });
  expect(summarize.mock.calls[0][0]).toContain("Revised before the first node");
});
