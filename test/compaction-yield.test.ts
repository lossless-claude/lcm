import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CompactionEngine, type CompactionConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const MAX_EVENT_LOOP_GAP_MS = 1_000;
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
  expect(items.map(item => item.ordinal)).toEqual(items.map((_, index) => index));
  expect(items[10]).toMatchObject({ itemType: "summary", summaryId: "range-summary" });
  expect(items.filter(item => item.itemType === "message").map(item => item.messageId))
    .toEqual([...messages.slice(0, 10), ...messages.slice(301)].map(message => message.messageId));
});

it("keeps timer gaps below 1,000 ms for 30,000 context items with unchanged summaries, links and tokens", async () => {
  const { summaries, conversationId, messages, compact } = await fixture(30_000);
  const leafContents: string[] = [];
  const summarize: CompactionSummarizeFn = async (text, _aggressive, options) => {
    if (options?.isCondensed) return "condensed result";
    const ids = [...text.matchAll(/message-(\d+):/g)].map(match => Number(match[1]));
    const content = `leaf:${ids[0]}-${ids.at(-1)}|${"s".repeat(3_000)}`;
    leafContents.push(content);
    return content;
  };
  let lastTurn = performance.now();
  let longestGap = 0;
  let timerTurns = 0;
  const recordTurn = () => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - lastTurn);
    lastTurn = now;
    timerTurns++;
  };
  const timer = setInterval(recordTurn, 1);
  let result;
  try {
    result = await compact(summarize);
    recordTurn(); // Include the final block even when no timer ran during compaction.
  } finally {
    clearInterval(timer);
  }
  console.info(`30,000-item compaction longest timer gap: ${longestGap.toFixed(1)} ms (${timerTurns} turns)`);
  expect(longestGap).toBeLessThan(MAX_EVENT_LOOP_GAP_MS);
  expect(timerTurns).toBeGreaterThan(2);

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
