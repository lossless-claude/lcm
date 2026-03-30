import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { ConversationStore } from "../../src/store/conversation-store.js";

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

function makeStore(db: DatabaseSync): SummaryStore {
  return new SummaryStore(db, { fts5Available: false });
}

async function makeConversation(db: DatabaseSync): Promise<number> {
  const cs = new ConversationStore(db, { fts5Available: false });
  const conv = await cs.createConversation({ sessionId: `sess-${Math.random()}` });
  return conv.conversationId;
}

// ── insertSummary / getSummary ────────────────────────────────────────────────

describe("SummaryStore — insertSummary / getSummary", () => {
  it("round-trips a leaf summary with required fields", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    const rec = await store.insertSummary({
      summaryId: "sum-001",
      conversationId: convId,
      kind: "leaf",
      content: "This is a leaf summary.",
      tokenCount: 10,
    });

    expect(rec.summaryId).toBe("sum-001");
    expect(rec.kind).toBe("leaf");
    expect(rec.content).toBe("This is a leaf summary.");
    expect(rec.tokenCount).toBe(10);
    expect(rec.depth).toBe(0); // default for leaf when depth omitted
    expect(rec.createdAt).toBeInstanceOf(Date);
    expect(rec.fileIds).toEqual([]);
    expect(rec.earliestAt).toBeNull();
    expect(rec.latestAt).toBeNull();
    expect(rec.descendantCount).toBe(0);
    expect(rec.descendantTokenCount).toBe(0);
    expect(rec.sourceMessageTokenCount).toBe(0);
  });

  it("round-trips a condensed summary with all optional fields", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);
    const earliest = new Date("2024-01-01T00:00:00Z");
    const latest = new Date("2024-06-01T00:00:00Z");

    const rec = await store.insertSummary({
      summaryId: "sum-002",
      conversationId: convId,
      kind: "condensed",
      depth: 2,
      content: "Condensed summary content.",
      tokenCount: 50,
      fileIds: ["file-a", "file-b"],
      earliestAt: earliest,
      latestAt: latest,
      descendantCount: 5,
      descendantTokenCount: 200,
      sourceMessageTokenCount: 300,
    });

    expect(rec.kind).toBe("condensed");
    expect(rec.depth).toBe(2);
    expect(rec.fileIds).toEqual(["file-a", "file-b"]);
    expect(rec.earliestAt?.toISOString()).toBe(earliest.toISOString());
    expect(rec.latestAt?.toISOString()).toBe(latest.toISOString());
    expect(rec.descendantCount).toBe(5);
    expect(rec.descendantTokenCount).toBe(200);
    expect(rec.sourceMessageTokenCount).toBe(300);
  });

  it("getSummary returns null for unknown summaryId", async () => {
    const store = makeStore(makeDb());
    expect(await store.getSummary("no-such-id")).toBeNull();
  });

  it("getSummariesByConversation returns all summaries for a conversation", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "s1", conversationId: convId, kind: "leaf", content: "a", tokenCount: 1 });
    await store.insertSummary({ summaryId: "s2", conversationId: convId, kind: "leaf", content: "b", tokenCount: 1 });

    const summaries = await store.getSummariesByConversation(convId);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.summaryId)).toContain("s1");
    expect(summaries.map((s) => s.summaryId)).toContain("s2");
  });

  it("defaults depth to 1 for condensed kind when depth is omitted", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    const rec = await store.insertSummary({
      summaryId: "sum-cond-nodepth",
      conversationId: convId,
      kind: "condensed",
      content: "no explicit depth",
      tokenCount: 5,
    });

    expect(rec.depth).toBe(1);
  });

  it("clamps negative numeric fields to 0", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    const rec = await store.insertSummary({
      summaryId: "sum-neg",
      conversationId: convId,
      kind: "leaf",
      content: "negative fields",
      tokenCount: 5,
      descendantCount: -3,
      descendantTokenCount: -100,
      sourceMessageTokenCount: -50,
    });

    expect(rec.descendantCount).toBe(0);
    expect(rec.descendantTokenCount).toBe(0);
    expect(rec.sourceMessageTokenCount).toBe(0);
  });
});

// ── linkSummaryToMessages / getSummaryMessages ────────────────────────────────

describe("SummaryStore — linkSummaryToMessages", () => {
  it("returns message ids in ordinal order after linking", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const cs = new ConversationStore(db, { fts5Available: false });
    const conv = await cs.createConversation({ sessionId: "link-sess" });
    const m1 = await cs.createMessage({ conversationId: conv.conversationId, seq: 1, role: "user", content: "a", tokenCount: 1 });
    const m2 = await cs.createMessage({ conversationId: conv.conversationId, seq: 2, role: "user", content: "b", tokenCount: 1 });

    await store.insertSummary({ summaryId: "link-sum", conversationId: conv.conversationId, kind: "leaf", content: "x", tokenCount: 1 });
    await store.linkSummaryToMessages("link-sum", [m1.messageId, m2.messageId]);

    const msgIds = await store.getSummaryMessages("link-sum");
    expect(msgIds).toEqual([m1.messageId, m2.messageId]);
  });

  it("linkSummaryToMessages with empty array is a no-op", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);
    await store.insertSummary({ summaryId: "empty-link", conversationId: convId, kind: "leaf", content: "x", tokenCount: 1 });
    await store.linkSummaryToMessages("empty-link", []);
    expect(await store.getSummaryMessages("empty-link")).toEqual([]);
  });

  it("duplicate link insertions are ignored (ON CONFLICT DO NOTHING)", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const cs = new ConversationStore(db, { fts5Available: false });
    const conv = await cs.createConversation({ sessionId: "dup-link-sess" });
    const m = await cs.createMessage({ conversationId: conv.conversationId, seq: 1, role: "user", content: "msg", tokenCount: 1 });

    await store.insertSummary({ summaryId: "dup-sum", conversationId: conv.conversationId, kind: "leaf", content: "x", tokenCount: 1 });
    await store.linkSummaryToMessages("dup-sum", [m.messageId]);
    await store.linkSummaryToMessages("dup-sum", [m.messageId]); // duplicate — must not throw

    const ids = await store.getSummaryMessages("dup-sum");
    expect(ids).toHaveLength(1);
  });
});

// ── linkSummaryToParents / getSummaryParents / getSummaryChildren ─────────────

describe("SummaryStore — parent/child links", () => {
  it("getSummaryParents returns parent summary records", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "parent-1", conversationId: convId, kind: "leaf", content: "parent", tokenCount: 5 });
    await store.insertSummary({ summaryId: "child-1", conversationId: convId, kind: "condensed", content: "child", tokenCount: 10 });

    await store.linkSummaryToParents("child-1", ["parent-1"]);

    const parents = await store.getSummaryParents("child-1");
    expect(parents).toHaveLength(1);
    expect(parents[0].summaryId).toBe("parent-1");

    const children = await store.getSummaryChildren("parent-1");
    expect(children).toHaveLength(1);
    expect(children[0].summaryId).toBe("child-1");
  });

  it("linkSummaryToParents with empty array is a no-op", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);
    await store.insertSummary({ summaryId: "solo", conversationId: convId, kind: "leaf", content: "x", tokenCount: 1 });
    await store.linkSummaryToParents("solo", []);
    expect(await store.getSummaryParents("solo")).toEqual([]);
  });
});

// ── getSummarySubtree ─────────────────────────────────────────────────────────

describe("SummaryStore — getSummarySubtree", () => {
  it("returns only the root when it has no children", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "root-only", conversationId: convId, kind: "leaf", content: "root", tokenCount: 1 });
    const subtree = await store.getSummarySubtree("root-only");
    expect(subtree).toHaveLength(1);
    expect(subtree[0].summaryId).toBe("root-only");
    expect(subtree[0].depthFromRoot).toBe(0);
    expect(subtree[0].parentSummaryId).toBeNull();
  });

  it("includes children at correct depthFromRoot", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "tree-root", conversationId: convId, kind: "condensed", content: "root", tokenCount: 1 });
    await store.insertSummary({ summaryId: "tree-child", conversationId: convId, kind: "leaf", content: "child", tokenCount: 1 });
    await store.linkSummaryToParents("tree-child", ["tree-root"]);

    const subtree = await store.getSummarySubtree("tree-root");
    expect(subtree).toHaveLength(2);

    const root = subtree.find((n) => n.summaryId === "tree-root");
    const child = subtree.find((n) => n.summaryId === "tree-child");
    expect(root?.depthFromRoot).toBe(0);
    expect(child?.depthFromRoot).toBe(1);
    expect(child?.parentSummaryId).toBe("tree-root");
  });
});

// ── Context item operations ───────────────────────────────────────────────────

describe("SummaryStore — context items", () => {
  let db: DatabaseSync;
  let store: SummaryStore;
  let convId: number;

  beforeEach(async () => {
    db = makeDb();
    store = makeStore(db);
    convId = await makeConversation(db);
  });

  it("appendContextSummary then getContextItems returns summary item", async () => {
    await store.insertSummary({ summaryId: "ctx-sum", conversationId: convId, kind: "leaf", content: "ctx content", tokenCount: 5 });
    await store.appendContextSummary(convId, "ctx-sum");

    const items = await store.getContextItems(convId);
    expect(items).toHaveLength(1);
    expect(items[0].itemType).toBe("summary");
    expect(items[0].summaryId).toBe("ctx-sum");
    expect(items[0].ordinal).toBe(0);
  });

  it("appendContextMessage then getContextItems returns message item", async () => {
    const cs = new ConversationStore(db, { fts5Available: false });
    const msg = await cs.createMessage({ conversationId: convId, seq: 1, role: "user", content: "hi", tokenCount: 1 });
    await store.appendContextMessage(convId, msg.messageId);

    const items = await store.getContextItems(convId);
    expect(items).toHaveLength(1);
    expect(items[0].itemType).toBe("message");
    expect(items[0].messageId).toBe(msg.messageId);
  });

  it("appendContextMessages in bulk assigns sequential ordinals", async () => {
    const cs = new ConversationStore(db, { fts5Available: false });
    const m1 = await cs.createMessage({ conversationId: convId, seq: 1, role: "user", content: "a", tokenCount: 1 });
    const m2 = await cs.createMessage({ conversationId: convId, seq: 2, role: "user", content: "b", tokenCount: 1 });
    await store.appendContextMessages(convId, [m1.messageId, m2.messageId]);

    const items = await store.getContextItems(convId);
    expect(items).toHaveLength(2);
    expect(items[0].ordinal).toBe(0);
    expect(items[1].ordinal).toBe(1);
  });

  it("appendContextMessages with empty array is a no-op", async () => {
    await store.appendContextMessages(convId, []);
    expect(await store.getContextItems(convId)).toHaveLength(0);
  });

  it("getContextTokenCount returns sum of message and summary token counts", async () => {
    const cs = new ConversationStore(db, { fts5Available: false });
    const msg = await cs.createMessage({ conversationId: convId, seq: 1, role: "user", content: "hi", tokenCount: 7 });
    await store.insertSummary({ summaryId: "tok-sum", conversationId: convId, kind: "leaf", content: "x", tokenCount: 13 });

    await store.appendContextMessage(convId, msg.messageId);
    await store.appendContextSummary(convId, "tok-sum");

    const total = await store.getContextTokenCount(convId);
    expect(total).toBe(20);
  });

  it("getContextTokenCount returns 0 for empty context", async () => {
    expect(await store.getContextTokenCount(convId)).toBe(0);
  });

  it("replaceContextRangeWithSummary replaces a range and resequences ordinals", async () => {
    const cs = new ConversationStore(db, { fts5Available: false });
    const msgs = await Promise.all([1, 2, 3].map((seq) =>
      cs.createMessage({ conversationId: convId, seq, role: "user", content: `msg${seq}`, tokenCount: 1 }),
    ));
    await store.appendContextMessages(convId, msgs.map((m) => m.messageId));

    await store.insertSummary({ summaryId: "replace-sum", conversationId: convId, kind: "condensed", content: "summary", tokenCount: 5 });
    await store.replaceContextRangeWithSummary({ conversationId: convId, startOrdinal: 0, endOrdinal: 1, summaryId: "replace-sum" });

    const items = await store.getContextItems(convId);
    // 2 items deleted (ordinals 0 and 1), 1 summary inserted at 0, msg at ordinal 2 shifts to 1
    expect(items).toHaveLength(2);
    expect(items[0].itemType).toBe("summary");
    expect(items[0].ordinal).toBe(0);
    expect(items[1].itemType).toBe("message");
    expect(items[1].ordinal).toBe(1);
  });
});

// ── searchSummaries — regex mode ──────────────────────────────────────────────

describe("SummaryStore — searchSummaries regex", () => {
  it("finds summaries matching a regex pattern", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "sreg-1", conversationId: convId, kind: "leaf", content: "agent hooks compaction", tokenCount: 3 });
    await store.insertSummary({ summaryId: "sreg-2", conversationId: convId, kind: "leaf", content: "unrelated content", tokenCount: 2 });

    const results = await store.searchSummaries({ query: "hook", mode: "regex" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.summaryId === "sreg-1")).toBe(true);
  });

  it("returns empty when no summary matches regex", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "nomatch-sum", conversationId: convId, kind: "leaf", content: "hello world", tokenCount: 2 });
    const results = await store.searchSummaries({ query: "xyz123nomatch", mode: "regex" });
    expect(results).toHaveLength(0);
  });

  it("throws on unsafe regex pattern", async () => {
    const store = makeStore(makeDb());
    await expect(
      store.searchSummaries({ query: "(a+)+$", mode: "regex" }), // codeql[js/redos] - intentional test input
    ).rejects.toThrow(/unsafe/i);
  });

  it("respects limit in regex search", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    for (let i = 1; i <= 5; i++) {
      await store.insertSummary({ summaryId: `rlim-${i}`, conversationId: convId, kind: "leaf", content: `item number ${i}`, tokenCount: 1 });
    }
    const results = await store.searchSummaries({ query: "item", mode: "regex", limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("filters by conversationId in regex search", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const cs = new ConversationStore(db, { fts5Available: false });
    const conv1 = await cs.createConversation({ sessionId: "filter-sess-1" });
    const conv2 = await cs.createConversation({ sessionId: "filter-sess-2" });

    await store.insertSummary({ summaryId: "flt-1", conversationId: conv1.conversationId, kind: "leaf", content: "target content", tokenCount: 2 });
    await store.insertSummary({ summaryId: "flt-2", conversationId: conv2.conversationId, kind: "leaf", content: "target content", tokenCount: 2 });

    const results = await store.searchSummaries({ query: "target", mode: "regex", conversationId: conv1.conversationId });
    expect(results.every((r) => r.conversationId === conv1.conversationId)).toBe(true);
    expect(results.some((r) => r.summaryId === "flt-1")).toBe(true);
    expect(results.some((r) => r.summaryId === "flt-2")).toBe(false);
  });
});

// ── searchSummaries — full_text fallback (fts5Available: false) ───────────────

describe("SummaryStore — searchSummaries full_text fallback (LIKE)", () => {
  it("finds summaries via LIKE fallback", async () => {
    const db = makeDb();
    const store = makeStore(db); // fts5Available: false
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "fts-1", conversationId: convId, kind: "leaf", content: "compaction summary flow", tokenCount: 3 });
    const results = await store.searchSummaries({ query: "compaction", mode: "full_text" });
    expect(results.some((r) => r.summaryId === "fts-1")).toBe(true);
  });

  it("returns empty for LIKE fallback when no match", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "fts-nomatch", conversationId: convId, kind: "leaf", content: "some summary", tokenCount: 2 });
    const results = await store.searchSummaries({ query: "zzznomatch", mode: "full_text" });
    expect(results).toHaveLength(0);
  });
});

// ── getDistinctDepthsInContext ────────────────────────────────────────────────

describe("SummaryStore — getDistinctDepthsInContext", () => {
  it("returns empty when no summary items in context", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);
    expect(await store.getDistinctDepthsInContext(convId)).toEqual([]);
  });

  it("returns distinct depth values for summary items", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "d0-sum", conversationId: convId, kind: "leaf", depth: 0, content: "x", tokenCount: 1 });
    await store.insertSummary({ summaryId: "d1-sum", conversationId: convId, kind: "condensed", depth: 1, content: "y", tokenCount: 1 });
    await store.appendContextSummary(convId, "d0-sum");
    await store.appendContextSummary(convId, "d1-sum");

    const depths = await store.getDistinctDepthsInContext(convId);
    expect(depths).toContain(0);
    expect(depths).toContain(1);
  });

  it("respects maxOrdinalExclusive bound", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertSummary({ summaryId: "ord-sum0", conversationId: convId, kind: "leaf", depth: 0, content: "x", tokenCount: 1 });
    await store.insertSummary({ summaryId: "ord-sum1", conversationId: convId, kind: "condensed", depth: 2, content: "y", tokenCount: 1 });
    await store.appendContextSummary(convId, "ord-sum0"); // ordinal 0
    await store.appendContextSummary(convId, "ord-sum1"); // ordinal 1

    // Only ordinals < 1 → only depth 0 summary at ordinal 0
    const depths = await store.getDistinctDepthsInContext(convId, { maxOrdinalExclusive: 1 });
    expect(depths).toContain(0);
    expect(depths).not.toContain(2);
  });
});

// ── LargeFile CRUD ────────────────────────────────────────────────────────────

describe("SummaryStore — LargeFile CRUD", () => {
  it("insertLargeFile and getLargeFile round-trip", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    const rec = await store.insertLargeFile({
      fileId: "file-001",
      conversationId: convId,
      fileName: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 204800,
      storageUri: "s3://bucket/report.pdf",
      explorationSummary: "A report about things.",
    });

    expect(rec.fileId).toBe("file-001");
    expect(rec.fileName).toBe("report.pdf");
    expect(rec.mimeType).toBe("application/pdf");
    expect(rec.byteSize).toBe(204800);
    expect(rec.storageUri).toBe("s3://bucket/report.pdf");
    expect(rec.explorationSummary).toBe("A report about things.");
    expect(rec.createdAt).toBeInstanceOf(Date);
  });

  it("insertLargeFile with minimal fields stores nulls", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    const rec = await store.insertLargeFile({
      fileId: "file-min",
      conversationId: convId,
      storageUri: "file:///tmp/data.bin",
    });

    expect(rec.fileName).toBeNull();
    expect(rec.mimeType).toBeNull();
    expect(rec.byteSize).toBeNull();
    expect(rec.explorationSummary).toBeNull();
  });

  it("getLargeFile returns null for unknown fileId", async () => {
    const store = makeStore(makeDb());
    expect(await store.getLargeFile("no-such-file")).toBeNull();
  });

  it("getLargeFilesByConversation returns all files for that conversation", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const convId = await makeConversation(db);

    await store.insertLargeFile({ fileId: "lf-a", conversationId: convId, storageUri: "s3://a" });
    await store.insertLargeFile({ fileId: "lf-b", conversationId: convId, storageUri: "s3://b" });

    const files = await store.getLargeFilesByConversation(convId);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.fileId)).toContain("lf-a");
    expect(files.map((f) => f.fileId)).toContain("lf-b");
  });

  it("getLargeFilesByConversation returns empty for unknown conversationId", async () => {
    const store = makeStore(makeDb());
    expect(await store.getLargeFilesByConversation(99999)).toEqual([]);
  });
});
