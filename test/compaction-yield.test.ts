import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CompactionEngine, type CompactionConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import * as projectQueue from "../src/daemon/project-queue.js";
import { clearConversationForRebuild } from "../src/claude-rebuild.js";
import { countContextCoverage } from "../src/store/context-coverage.js";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture(count: number, config: Partial<CompactionConfig> = {}, tokenCount = 1) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  runLcmMigrations(db);
  const conversations = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  const { conversationId } = await conversations.getOrCreateConversation("compaction-yield");
  const messages = await conversations.createMessagesBulk(Array.from({ length: count }, (_, seq) => ({
    conversationId, seq, role: "user" as const,
    content: `message-${seq}: ${"durable fact ".repeat(5)}`, tokenCount,
    eventAt: new Date("2026-01-01T00:00:00Z"),
  })));
  await summaries.appendContextMessages(conversationId, messages.map(message => message.messageId));
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.5, freshTailCount: 0, leafMinFanout: 3, condensedMinFanout: 2,
    leafChunkTokens: 5_000, condensedTargetTokens: 100, ...config,
  });
  const compact = (summarize: CompactionSummarizeFn) =>
    engine.compact({ conversationId, tokenBudget: 10_000, summarize, force: true });
  return { db, conversations, summaries, conversationId, messages, compact };
}

it("replaces a context range in one synchronous transaction, so a concurrent BEGIN IMMEDIATE on the connection succeeds", async () => {
  const contextItems = 600;
  const { db, summaries, conversationId, messages } = await fixture(contextItems);
  await summaries.insertSummary({ summaryId: "range-summary", conversationId, kind: "leaf", depth: 0, content: "range", tokenCount: 1 });
  let concurrentError: unknown;
  setImmediate(() => {
    try { db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT"); } catch (error) { concurrentError = error; }
  });
  await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 10, endOrdinal: 300, summaryId: "range-summary" });
  await new Promise(resolve => setImmediate(resolve));
  expect(concurrentError).toBeUndefined();
  const items = await summaries.getContextItems(conversationId);
  expect(items.map(item => item.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ...Array.from({ length: contextItems - 301 }, (_, i) => i + 301)]);
  expect(items[10]).toMatchObject({ itemType: "summary", summaryId: "range-summary" });
  expect(items.filter(item => item.itemType === "message").map(item => item.messageId))
    .toEqual([...messages.slice(0, 10), ...messages.slice(301)].map(message => message.messageId));
});

it("yields during 30,000-item compaction with unchanged summaries, links and tokens", async () => {
  const { summaries, conversationId, messages, compact } = await fixture(30_000);
  const leafContents: string[] = [];
  const summarize: CompactionSummarizeFn = async (text, _aggressive, options) => {
    if (options?.isCondensed) return "condensed result";
    const ids = [...text.matchAll(/message-(\d+):/g)].map(match => Number(match[1]));
    const content = `leaf:${ids[0]}-${ids.at(-1)}|${"s".repeat(3_000)}`;
    leafContents.push(content);
    return content;
  };
  const yields = vi.spyOn(projectQueue, "yieldToEventLoop");
  const result = await compact(summarize);
  expect(yields.mock.calls.length).toBeGreaterThanOrEqual(300);
  yields.mockRestore();

  expect(result).toMatchObject({ actionTaken: true, tokensBefore: 30_000, tokensAfter: 4, condensed: true });
  expect(result.createdSummaryIds).toHaveLength(7);
  const ids = result.createdSummaryIds!;
  for (let i = 0; i < 6; i++) {
    expect(leafContents[i]).toBe(`leaf:${i * 5_000}-${(i + 1) * 5_000 - 1}|${"s".repeat(3_000)}`);
    expect(await summaries.getSummary(ids[i])).toMatchObject({ content: leafContents[i], tokenCount: [753, 754, 755, 755, 755, 755][i] });
    expect(await summaries.getSummaryMessages(ids[i])).toEqual(messages.slice(i * 5_000, (i + 1) * 5_000).map(message => message.messageId));
  }
  expect(await summaries.getSummary(ids[6])).toMatchObject({ content: "condensed result", tokenCount: 4, depth: 1 });
  expect((await summaries.getSummaryParents(ids[6])).map(summary => summary.summaryId)).toEqual(ids.slice(0, 6));
  expect(await summaries.getContextTokenCount(conversationId)).toBe(4);
}, 180_000);

it("sums context tokens once and keeps leaf, condensed and event totals exact", async () => {
  const { conversations, summaries, conversationId, compact } = await fixture(6, {
    leafChunkTokens: 60, condensedTargetTokens: 1,
  }, 30);
  const count = vi.spyOn(summaries, "getContextTokenCount");
  const result = await compact(async (_text, _aggressive, options) => options?.isCondensed ? "done" : "s".repeat(40));
  expect(result).toMatchObject({ tokensBefore: 180, tokensAfter: 1, condensed: true });
  const events = (await conversations.getMessages(conversationId)).filter(message => message.role === "system");
  expect(events.map(event => event.content)).toEqual([
    "LCM compaction leaf pass (normal): 180 -> 130",
    "LCM compaction leaf pass (normal): 130 -> 80",
    "LCM compaction leaf pass (normal): 80 -> 30",
    "LCM compaction condensed pass (normal): 30 -> 1",
  ]);
  expect(count).toHaveBeenCalledTimes(1);
});

it("uses stored token counts in totals when chunk selection falls back for zero-token messages", async () => {
  const { compact } = await fixture(6, { leafChunkTokens: 60 }, 0);
  const result = await compact(async () => "s".repeat(40));
  expect(result).toMatchObject({ tokensBefore: 0, tokensAfter: 10, condensed: false });
  expect(result.createdSummaryIds).toHaveLength(1);
});

it("includes messages captured while summarization waits in the incremental total", async () => {
  const { conversations, summaries, conversationId, compact } = await fixture(4, {
    freshTailCount: 1, leafChunkTokens: 60, leafMinFanout: 2, condensedTargetTokens: 1,
  }, 30);
  const count = vi.spyOn(summaries, "getContextTokenCount");
  let appended = false;
  const result = await compact(async (_text, _aggressive, options) => {
    if (!appended) {
      appended = true;
      const message = await conversations.createMessage({ conversationId, seq: 4, role: "user", content: "new tail", tokenCount: 7 });
      await summaries.appendContextMessages(conversationId, [message.messageId]);
    }
    return options?.isCondensed ? "done" : "s".repeat(40);
  });
  expect(result).toMatchObject({ tokensBefore: 120, tokensAfter: 8, condensed: true });
  expect(count).toHaveBeenCalledTimes(1);
});

it("counts only new captures after sparse ordinals and protects the fresh tail", async () => {
  const { db, conversations, summaries, conversationId, messages, compact } = await fixture(6, {
    freshTailCount: 2, leafChunkTokens: 60, leafMinFanout: 2, condensedTargetTokens: 1,
  }, 30);
  // An existing sparse context, independent of the replacement implementation.
  db.exec("UPDATE context_items SET ordinal = ordinal * 10");
  const suffix = vi.spyOn(summaries, "getContextItems");
  const leafSources: number[][] = [];
  let appended = false;
  const result = await compact(async (text, _aggressive, options) => {
    if (!options?.isCondensed) leafSources.push([...text.matchAll(/message-(\d+):/g)].map(match => Number(match[1])));
    if (!appended) {
      appended = true;
      const message = await conversations.createMessage({ conversationId, seq: 6, role: "user", content: "new tail", tokenCount: 7 });
      await summaries.appendContextMessages(conversationId, [message.messageId]);
    }
    return options?.isCondensed ? "done" : "s".repeat(40);
  });
  expect(suffix.mock.calls.filter(([, options]) => options).map(([, options]) => options?.afterOrdinal))
    .toEqual([50, 51, 51, 51]);
  expect(leafSources).toEqual([[0, 1], [2, 3], [4]]);
  expect(result).toMatchObject({ tokensBefore: 180, tokensAfter: 38, condensed: true });
  // An append lands past the chunk's range, so it is not a changed source.
  expect(result.sourceChanged).toBeUndefined();
  expect(await summaries.getContextTokenCount(conversationId)).toBe(38);
  expect((await summaries.getContextItems(conversationId)).filter(item => item.itemType === "message").map(item => item.messageId))
    .toContain(messages[5].messageId);
  // Six seeded messages and the appended one, each covered once by the context.
  expect(countContextCoverage(db, conversationId).map(row => row.coverage)).toEqual(Array(7).fill(1));
});

it("discards a pass whose source a writer cleared while the model ran, leaving no summary or index row", async () => {
  const discarded = vi.fn();
  const { db, conversationId, compact } = await fixture(6, { leafChunkTokens: 60, onAnswerDiscarded: discarded }, 30);
  const result = await compact(async () => {
    // A worker purge's clear, by a writer that skips the session's compaction guard.
    db.exec("BEGIN");
    clearConversationForRebuild(db, conversationId, "compaction-yield");
    db.exec("COMMIT");
    return "s".repeat(40);
  });
  expect(result).toMatchObject({ actionTaken: false, sourceChanged: true, createdSummaryIds: [], tokensAfter: 0 });
  expect(discarded).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM summaries_fts").get()).toEqual({ n: 0 });
});

it("keeps earlier passes and stops when another writer replaced part of a chunk while the model ran", async () => {
  const discarded = vi.fn();
  const { db, summaries, conversationId, messages, compact } = await fixture(6, { leafChunkTokens: 60, onAnswerDiscarded: discarded }, 30);
  let calls = 0;
  const result = await compact(async () => {
    if (++calls === 2) {
      // The second chunk is ordinals 2-3; this writer summarizes 3-4 meanwhile.
      await summaries.insertSummary({ summaryId: "overlap", conversationId, kind: "leaf", depth: 0, content: "overlap", tokenCount: 1 });
      await summaries.linkSummaryToMessages("overlap", [messages[3].messageId, messages[4].messageId]);
      await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 3, endOrdinal: 4, summaryId: "overlap" });
    }
    return "s".repeat(40);
  });
  expect(calls).toBe(2);
  expect(result).toMatchObject({ actionTaken: true, sourceChanged: true, condensed: false });
  expect(result.createdSummaryIds).toHaveLength(1);
  expect(discarded).toHaveBeenCalledTimes(1);
  expect((await summaries.getContextItems(conversationId)).map(item => item.summaryId ?? item.messageId))
    .toEqual([result.createdSummaryId, messages[2].messageId, "overlap", messages[5].messageId]);
  expect(countContextCoverage(db, conversationId).map(row => row.coverage)).toEqual(Array(6).fill(1));
  expect(summaries.getOrphanSummaryIds()).toEqual([]);
});

it("stops before condensing when a later leaf pass's source changed", async () => {
  const { summaries, conversationId, messages, compact } = await fixture(6, { leafChunkTokens: 60, condensedTargetTokens: 1 }, 30);
  const kinds: string[] = [];
  const result = await compact(async (_text, _aggressive, options) => {
    kinds.push(options?.isCondensed ? "condensed" : "leaf");
    if (kinds.length === 3) {
      // Two leaf summaries already stand side by side; the third chunk is ordinals 4-5,
      // and another writer summarizes ordinal 4 meanwhile.
      await summaries.insertSummary({ summaryId: "overlap", conversationId, kind: "leaf", depth: 0, content: "overlap", tokenCount: 1 });
      await summaries.linkSummaryToMessages("overlap", [messages[4].messageId]);
      await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 4, endOrdinal: 4, summaryId: "overlap" });
    }
    return options?.isCondensed ? "done" : "s".repeat(40);
  });
  // A condensed pass now would spend another model call after a discarded one.
  expect(kinds).toEqual(["leaf", "leaf", "leaf"]);
  expect(result).toMatchObject({ actionTaken: true, condensed: false, sourceChanged: true });
  expect(result.createdSummaryIds).toHaveLength(2);
});

it("discards a condensed pass whose source a writer cleared while the model ran", async () => {
  const discarded = vi.fn();
  const { db, summaries, conversationId, compact } = await fixture(6, {
    leafChunkTokens: 60, condensedTargetTokens: 1, onAnswerDiscarded: discarded,
  }, 30);
  let condensedCalls = 0;
  const result = await compact(async (_text, _aggressive, options) => {
    if (options?.isCondensed && ++condensedCalls === 1) {
      db.exec("BEGIN");
      clearConversationForRebuild(db, conversationId, "compaction-yield");
      db.exec("COMMIT");
    }
    return options?.isCondensed ? "done" : "s".repeat(40);
  });
  expect(condensedCalls).toBe(1);
  expect(result).toMatchObject({ actionTaken: true, condensed: false, sourceChanged: true, tokensAfter: 0 });
  expect(result.createdSummaryIds).toHaveLength(3);
  expect(discarded).toHaveBeenCalledTimes(1);
  expect(summaries.getOrphanSummaryIds()).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM summaries_fts").get()).toEqual({ n: 0 });
});

it("discards a condensed pass when another writer swapped one of its summaries at the same ordinal", async () => {
  const { db, summaries, conversationId, messages, compact } = await fixture(6, { leafChunkTokens: 60, condensedTargetTokens: 1 }, 30);
  let condensedCalls = 0;
  const result = await compact(async (_text, _aggressive, options) => {
    if (options?.isCondensed && ++condensedCalls === 1) {
      // The first leaf summary, of messages 0-1, sits at ordinal 0. Its replacement has the
      // same ordinal and item type and no message id: only the summary id tells them apart.
      await summaries.insertSummary({ summaryId: "swapped", conversationId, kind: "leaf", depth: 0, content: "swapped", tokenCount: 1 });
      await summaries.linkSummaryToMessages("swapped", [messages[0].messageId, messages[1].messageId]);
      await summaries.replaceContextRangeWithSummary({ conversationId, startOrdinal: 0, endOrdinal: 0, summaryId: "swapped" });
    }
    return options?.isCondensed ? "done" : "s".repeat(40);
  });
  expect(condensedCalls).toBe(1);
  expect(result).toMatchObject({ actionTaken: true, condensed: false, sourceChanged: true });
  expect(result.createdSummaryIds).toHaveLength(3);
  const [, secondLeaf, thirdLeaf] = result.createdSummaryIds ?? [];
  expect((await summaries.getContextItems(conversationId)).map(item => item.summaryId))
    .toEqual(["swapped", secondLeaf, thirdLeaf]);
  expect(countContextCoverage(db, conversationId).map(row => row.coverage)).toEqual(Array(6).fill(1));
});
