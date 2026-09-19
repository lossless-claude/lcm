import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { ConversationStore, type MessageRecord, type MessageRole } from "../../src/store/conversation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): DatabaseSync {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-summary-store-test-"));
  tempDirs.push(tempDir);
  const db = getLcmConnection(join(tempDir, "test.db"));
  runLcmMigrations(db);
  return db;
}

type Fixture = { db: DatabaseSync; store: SummaryStore; conversations: ConversationStore; convId: number };

async function makeFixture(): Promise<Fixture> {
  const db = makeDb();
  const conversations = new ConversationStore(db, { fts5Available: false });
  const convId = (await conversations.getOrCreateConversation(`sess-${Math.random()}`)).conversationId;
  return { db, store: new SummaryStore(db, { fts5Available: false }), conversations, convId };
}

/** Appends messages to the conversation and to its context, the way capture does. */
async function appendMessages(fx: Fixture, contents: string[], role: MessageRole = "user"): Promise<MessageRecord[]> {
  const seq = await fx.conversations.getMaxSeq(fx.convId);
  const records = await fx.conversations.createMessagesBulk(
    contents.map((content, i) => ({ conversationId: fx.convId, seq: seq + 1 + i, role, content, tokenCount: 1 })),
  );
  await fx.store.appendContextMessages(fx.convId, records.map((r) => r.messageId));
  return records;
}

// ── insertSummary / getSummary ────────────────────────────────────────────────

describe("SummaryStore — summaries", () => {
  it("insertSummary then getSummary round-trips a leaf with defaults", async () => {
    const { store, convId } = await makeFixture();
    const rec = await store.insertSummary({ summaryId: "sum-001", conversationId: convId, kind: "leaf", content: "A leaf.", tokenCount: 10 });
    expect(rec).toMatchObject({
      summaryId: "sum-001", kind: "leaf", content: "A leaf.", tokenCount: 10, depth: 0, fileIds: [],
      earliestAt: null, latestAt: null, descendantCount: 0, descendantTokenCount: 0, sourceMessageTokenCount: 0,
    });
    expect(rec.createdAt).toBeInstanceOf(Date);
    expect(await store.getSummary("sum-001")).toEqual(rec);
    expect(store.getSummarySync("sum-001")).toEqual(rec);
    expect(await store.getSummary("no-such-id")).toBeNull();
  });

  it("insertSummary keeps every optional field of a condensed summary", async () => {
    const { store, convId } = await makeFixture();
    const earliest = new Date("2024-01-01T00:00:00Z");
    const latest = new Date("2024-06-01T00:00:00Z");
    const rec = await store.insertSummary({
      summaryId: "sum-002", conversationId: convId, kind: "condensed", depth: 2, content: "Condensed.", tokenCount: 50,
      fileIds: ["file-a", "file-b"], earliestAt: earliest, latestAt: latest,
      descendantCount: 5, descendantTokenCount: 200, sourceMessageTokenCount: 300,
    });
    expect(rec).toMatchObject({ kind: "condensed", depth: 2, fileIds: ["file-a", "file-b"], descendantCount: 5, descendantTokenCount: 200, sourceMessageTokenCount: 300 });
    expect(rec.earliestAt?.toISOString()).toBe(earliest.toISOString());
    expect(rec.latestAt?.toISOString()).toBe(latest.toISOString());
  });

  it("insertSummary defaults a condensed depth to 1 and clamps negative counts to 0", async () => {
    const { store, convId } = await makeFixture();
    const condensed = await store.insertSummary({ summaryId: "sum-cond", conversationId: convId, kind: "condensed", content: "x", tokenCount: 5 });
    expect(condensed.depth).toBe(1);
    const negative = await store.insertSummary({
      summaryId: "sum-neg", conversationId: convId, kind: "leaf", content: "x", tokenCount: 5,
      descendantCount: -3, descendantTokenCount: -100, sourceMessageTokenCount: -50,
    });
    expect(negative).toMatchObject({ descendantCount: 0, descendantTokenCount: 0, sourceMessageTokenCount: 0 });
  });

  it("getSummariesByConversation, summariesDeepestFirst, listRecent and countSummaries read what was inserted", async () => {
    const fx = await makeFixture();
    const other = (await fx.conversations.getOrCreateConversation("other")).conversationId;
    await fx.store.insertSummary({ summaryId: "s1", conversationId: fx.convId, kind: "leaf", depth: 0, content: "a", tokenCount: 1 });
    await fx.store.insertSummary({ summaryId: "s2", conversationId: fx.convId, kind: "condensed", depth: 1, content: "b", tokenCount: 1 });
    await fx.store.insertSummary({ summaryId: "s3", conversationId: other, kind: "leaf", depth: 0, content: "c", tokenCount: 1 });
    fx.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`).run("2026-01-01 00:00:00", "s1");
    fx.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`).run("2026-01-02 00:00:00", "s2");
    fx.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`).run("2026-01-03 00:00:00", "s3");

    expect((await fx.store.getSummariesByConversation(fx.convId)).map((s) => s.summaryId)).toEqual(["s1", "s2"]);
    expect((await fx.store.summariesDeepestFirst(fx.convId, 1)).map((s) => s.summaryId)).toEqual(["s2"]);
    expect((await fx.store.listRecent(2)).map((s) => s.summaryId)).toEqual(["s3", "s2"]);
    expect(await fx.store.countSummaries(fx.convId)).toBe(2);
    expect(await fx.store.countSummaries()).toBe(3);
  });
});

// ── Lineage ───────────────────────────────────────────────────────────────────

describe("SummaryStore — lineage", () => {
  it("linkSummaryToMessages records the source messages once, in order", async () => {
    const fx = await makeFixture();
    const [m1, m2] = await appendMessages(fx, ["a", "b"]);
    await fx.store.insertSummary({ summaryId: "link-sum", conversationId: fx.convId, kind: "leaf", content: "x", tokenCount: 1 });
    await fx.store.linkSummaryToMessages("link-sum", []);
    expect(await fx.store.getSummaryMessages("link-sum")).toEqual([]);

    await fx.store.linkSummaryToMessages("link-sum", [m1.messageId, m2.messageId]);
    await fx.store.linkSummaryToMessages("link-sum", [m1.messageId]); // a repeat must not throw or duplicate
    expect(await fx.store.getSummaryMessages("link-sum")).toEqual([m1.messageId, m2.messageId]);
  });

  it("linkSummaryToParents is read back from both ends and as a subtree", async () => {
    const { store, convId } = await makeFixture();
    await store.insertSummary({ summaryId: "root", conversationId: convId, kind: "condensed", content: "root", tokenCount: 5 });
    await store.insertSummary({ summaryId: "child", conversationId: convId, kind: "leaf", content: "child", tokenCount: 10 });
    await store.linkSummaryToParents("child", []);
    expect(await store.getSummaryParents("child")).toEqual([]);

    await store.linkSummaryToParents("child", ["root"]);
    expect((await store.getSummaryParents("child")).map((s) => s.summaryId)).toEqual(["root"]);
    expect((await store.getSummaryChildren("root")).map((s) => s.summaryId)).toEqual(["child"]);

    const subtree = await store.getSummarySubtree("root");
    expect(subtree.map((n) => [n.summaryId, n.depthFromRoot, n.parentSummaryId])).toEqual([["root", 0, null], ["child", 1, "root"]]);
    expect(await store.getSummarySubtree("child")).toHaveLength(1);
  });
});

// ── Context: append, replace, read ────────────────────────────────────────────

describe("SummaryStore — context", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await makeFixture();
  });

  it("appendContextMessages then getContextItems returns the messages in order with contiguous ordinals", async () => {
    await fx.store.appendContextMessages(fx.convId, []);
    expect(await fx.store.getContextItems(fx.convId)).toHaveLength(0);

    const [m1, m2] = await appendMessages(fx, ["a", "b"]);
    const [m3] = await appendMessages(fx, ["c"]);
    const items = await fx.store.getContextItems(fx.convId);
    expect(items.map((i) => [i.ordinal, i.itemType, i.messageId])).toEqual([[0, "message", m1.messageId], [1, "message", m2.messageId], [2, "message", m3.messageId]]);
  });

  it("replaceContextRangeWithSummary then reading the window shows the summary in place of the range", async () => {
    const [m1, m2, m3] = await appendMessages(fx, ["msg1", "msg2", "msg3"]);
    await fx.store.insertSummary({ summaryId: "replace-sum", conversationId: fx.convId, kind: "leaf", content: "summary of 1-2", tokenCount: 5 });
    await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: 0, endOrdinal: 1, summaryId: "replace-sum" });

    const items = await fx.store.getContextItems(fx.convId);
    expect(items.map((i) => [i.ordinal, i.itemType, i.summaryId ?? i.messageId])).toEqual([[0, "summary", "replace-sum"], [1, "message", m3.messageId]]);
    expect([m1, m2].map((m) => m.messageId)).not.toContain(items[1].messageId);

    const window = await fx.store.readContextWindow(fx.convId, 10);
    expect(window.map((i) => [i.itemType, i.role, i.content])).toEqual([["summary", null, "summary of 1-2"], ["message", "user", "msg3"]]);
    expect(await fx.store.getDistinctDepthsInContext(fx.convId)).toEqual([0]);
  });

  it("readContextWindow keeps the last N of each kind, skips tool messages, and falls back to messages when no context was materialised", async () => {
    await appendMessages(fx, ["u1", "u2", "u3"]);
    await appendMessages(fx, ["tool output"], "tool");
    for (const [i, id] of ["sum-a", "sum-b"].entries()) {
      await fx.store.insertSummary({ summaryId: id, conversationId: fx.convId, kind: "leaf", content: id, tokenCount: 1 });
      await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: i, endOrdinal: i, summaryId: id });
    }
    // context: sum-a, sum-b, u3, tool
    const window = await fx.store.readContextWindow(fx.convId, 1);
    expect(window.map((i) => i.content)).toEqual(["sum-b", "u3"]);

    const bare = (await fx.conversations.getOrCreateConversation("never-materialised")).conversationId;
    await fx.conversations.createMessagesBulk([
      { conversationId: bare, seq: 0, role: "user", content: "first", tokenCount: 1 },
      { conversationId: bare, seq: 1, role: "assistant", content: "second", tokenCount: 1 },
      { conversationId: bare, seq: 2, role: "tool", content: "log", tokenCount: 1 },
    ]);
    expect((await fx.store.readContextWindow(bare, 1)).map((i) => [i.role, i.content])).toEqual([["assistant", "second"]]);
    expect(await fx.store.readContextWindow(bare, 0)).toEqual([]);
  });

  it("getContextTokenCount sums what the window holds, messages and summaries alike", async () => {
    expect(await fx.store.getContextTokenCount(fx.convId)).toBe(0);
    await appendMessages(fx, ["a", "b"]);
    await fx.store.insertSummary({ summaryId: "tok-sum", conversationId: fx.convId, kind: "leaf", content: "x", tokenCount: 13 });
    await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: 0, endOrdinal: 0, summaryId: "tok-sum" });
    expect(await fx.store.getContextTokenCount(fx.convId)).toBe(14);
  });

  it("getDistinctDepthsInContext lists the summary depths, bounded by an ordinal", async () => {
    expect(await fx.store.getDistinctDepthsInContext(fx.convId)).toEqual([]);
    await appendMessages(fx, ["a", "b"]);
    await fx.store.insertSummary({ summaryId: "d0", conversationId: fx.convId, kind: "leaf", depth: 0, content: "x", tokenCount: 1 });
    await fx.store.insertSummary({ summaryId: "d2", conversationId: fx.convId, kind: "condensed", depth: 2, content: "y", tokenCount: 1 });
    await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: 0, endOrdinal: 0, summaryId: "d0" });
    await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: 1, endOrdinal: 1, summaryId: "d2" });

    expect(await fx.store.getDistinctDepthsInContext(fx.convId)).toEqual([0, 2]);
    expect(await fx.store.getDistinctDepthsInContext(fx.convId, { maxOrdinalExclusive: 1 })).toEqual([0]);
  });

  it("resetConversationContext drops every summary and rebuilds the context from the messages", async () => {
    const records = await appendMessages(fx, ["a", "b", "c"]);
    await fx.store.insertSummary({ summaryId: "gone", conversationId: fx.convId, kind: "leaf", content: "x", tokenCount: 1 });
    await fx.store.linkSummaryToMessages("gone", [records[0].messageId, records[1].messageId]);
    await fx.store.replaceContextRangeWithSummary({ conversationId: fx.convId, startOrdinal: 0, endOrdinal: 1, summaryId: "gone" });

    expect(await fx.store.resetConversationContext(fx.convId)).toBe(1);
    expect(await fx.store.countSummaries(fx.convId)).toBe(0);
    expect(await fx.store.getSummary("gone")).toBeNull();
    expect((await fx.store.getContextItems(fx.convId)).map((i) => [i.ordinal, i.messageId])).toEqual(records.map((r, i) => [i, r.messageId]));
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe("SummaryStore — searchSummariesSync", () => {
  it("regex mode finds matching summaries within a conversation, honours the limit, and refuses an unsafe pattern", async () => {
    const fx = await makeFixture();
    const other = (await fx.conversations.getOrCreateConversation("other")).conversationId;
    for (let i = 1; i <= 5; i++) {
      await fx.store.insertSummary({ summaryId: `item-${i}`, conversationId: fx.convId, kind: "leaf", content: `item number ${i}`, tokenCount: 1 });
    }
    await fx.store.insertSummary({ summaryId: "elsewhere", conversationId: other, kind: "leaf", content: "item elsewhere", tokenCount: 1 });

    expect(fx.store.searchSummariesSync({ query: "item", mode: "regex" })).toHaveLength(6);
    expect(fx.store.searchSummariesSync({ query: "item", mode: "regex", limit: 2 })).toHaveLength(2);
    const scoped = fx.store.searchSummariesSync({ query: "item", mode: "regex", conversationId: fx.convId });
    expect(scoped.every((r) => r.conversationId === fx.convId)).toBe(true);
    expect(scoped).toHaveLength(5);
    expect(fx.store.searchSummariesSync({ query: "xyz123nomatch", mode: "regex" })).toHaveLength(0);
    expect(() => fx.store.searchSummariesSync({ query: "(a+)+$", mode: "regex" })) // codeql[js/redos] - intentional test input
      .toThrow(/unsafe/i);
  });

  it("full_text mode falls back to a substring scan without FTS5", async () => {
    const { store, convId } = await makeFixture();
    await store.insertSummary({ summaryId: "fts-1", conversationId: convId, kind: "leaf", content: "compaction summary flow", tokenCount: 3 });
    expect(store.searchSummariesSync({ query: "compaction", mode: "full_text" }).map((r) => r.summaryId)).toEqual(["fts-1"]);
    expect(store.searchSummariesSync({ query: "zzznomatch", mode: "full_text" })).toHaveLength(0);
  });
});

// ── Large files ───────────────────────────────────────────────────────────────

describe("SummaryStore — getLargeFile", () => {
  it("answers null for a file nothing recorded", async () => {
    const { store } = await makeFixture();
    expect(await store.getLargeFile("no-such-file")).toBeNull();
  });
});
