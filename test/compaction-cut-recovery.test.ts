import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { CompactionEngine, type CompactionConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { createProviderChain } from "../src/llm/provider-chain.js";
import { SummaryRejectedError } from "../src/llm/summary-rejection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RetrievalEngine } from "../src/retrieval.js";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture(count: number, config: Partial<CompactionConfig> = {}, content?: string) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  runLcmMigrations(db);
  const conversations = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  const { conversationId } = await conversations.getOrCreateConversation("cut-recovery");
  const messages = await conversations.createMessagesBulk(Array.from({ length: count }, (_, i) => ({
    conversationId, seq: i, role: "user" as const,
    content: content ?? `message-${i}: ${"durable source fact ".repeat(300)}`, tokenCount: 1_500,
    eventAt: new Date("2026-01-01T00:00:00Z"), eventTimeSource: "transcript" as const,
  })));
  await summaries.appendContextMessages(conversationId, messages.map(message => message.messageId));
  const engine = new CompactionEngine(conversations, summaries, {
    contextThreshold: 0.5, freshTailCount: 0, leafMinFanout: 100, condensedMinFanout: 100,
    leafChunkTokens: 20_000, condensedTargetTokens: 100,
    ...config,
  });
  const compact = (summarize: CompactionSummarizeFn) =>
    engine.compact({ conversationId, tokenBudget: 10_000, summarize, force: true });
  return { conversations, summaries, messages, compact };
}

function alwaysCut() {
  const adapter = vi.fn(async (_text: string, _aggressive?: boolean, ctx?: { maxOutputTokens?: number }): Promise<string> => {
    throw new SummaryRejectedError({ reason: "length", provider: "test", model: "looping-model",
      maxOutputTokens: ctx?.maxOutputTokens ?? 1_024 });
  });
  const summarize = createProviderChain([() => ({ name: "test", kind: "http", summarizer: async () => adapter })]);
  return { adapter, summarize };
}

it("a single message cut twice completes at fallback and retains its raw source", async () => {
  const { conversations, summaries, messages, compact } = await fixture(1);
  const { adapter, summarize } = alwaysCut();

  const result = await compact(summarize);

  expect(result).toMatchObject({ actionTaken: true, level: "fallback" });
  expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  expect(adapter).toHaveBeenCalledTimes(2);
  const summary = await summaries.getSummary(result.createdSummaryId!);
  expect(summary!.content).toContain("[Truncated from");
  expect(await summaries.getSummaryMessages(result.createdSummaryId!)).toEqual([messages[0].messageId]);
  expect(await conversations.getMessageById(messages[0].messageId)).toMatchObject({ content: messages[0].content });
  const expanded = await new RetrievalEngine(conversations, summaries).expand({
    summaryId: result.createdSummaryId!, includeMessages: true,
  });
  expect(expanded.messages).toEqual([{
    messageId: messages[0].messageId, role: "user", content: messages[0].content, tokenCount: 1_500,
  }]);
  expect(expanded.truncated).toBe(false);
});

it("always-cut chunks halve at message boundaries with at most 4n - 2 provider calls", async () => {
  const { summaries, messages, compact } = await fixture(5);
  const { adapter, summarize } = alwaysCut();

  const result = await compact(summarize);

  expect(result).toMatchObject({ actionTaken: true, level: "fallback" });
  expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  expect(adapter).toHaveBeenCalledTimes(18);
  const sources = adapter.mock.calls.map(([text]) => [...text.matchAll(/message-(\d+):/g)].map(match => Number(match[1])));
  expect(sources.filter((_, i) => i % 2 === 0)).toEqual([
    [0, 1, 2, 3, 4], [0, 1], [0], [1], [2, 3, 4], [2], [3, 4], [3], [4],
  ]);
  for (const [i, , ctx] of adapter.mock.calls.map((call, i) => [i, call[1], call[2]] as const)) {
    expect(ctx?.maxOutputTokens).toBe(i % 2 ? 2_048 : undefined);
  }
  expect(await summaries.getSummaryMessages(result.createdSummaryId!)).toEqual(messages.map(message => message.messageId));
  const summary = await summaries.getSummary(result.createdSummaryId!);
  for (let i = 0; i < 5; i++) expect(summary!.content).toContain(`message-${i}:`);
});

it("splits when every endpoint cuts, retaining the same bound per endpoint", async () => {
  const { compact } = await fixture(3);
  const adapters = [alwaysCut(), alwaysCut()];
  const summarize = createProviderChain(adapters.map(({ adapter }, i) => () => ({
    name: `endpoint-${i}`, kind: "http" as const, summarizer: async () => adapter,
  })));

  const result = await compact(summarize);

  expect(result.level).toBe("fallback");
  for (const { adapter } of adapters) expect(adapter).toHaveBeenCalledTimes(10);
});

it("a cut followed by an accepted retry keeps today's normal level and stores only the accepted answer", async () => {
  const { summaries, compact } = await fixture(2);
  const { adapter, summarize } = alwaysCut();
  adapter.mockImplementationOnce(async () => {
    throw new SummaryRejectedError({ reason: "length", provider: "test", maxOutputTokens: 1_024 });
  }).mockResolvedValue("accepted complete summary");

  const result = await compact(summarize);

  expect(result.level).toBe("normal");
  expect(adapter).toHaveBeenCalledTimes(2);
  expect(await summaries.getSummary(result.createdSummaryId!)).toMatchObject({ content: "accepted complete summary" });
});

it("discards the attribution of accepted halves if their joined result still does not shrink", async () => {
  const onAnswerDiscarded = vi.fn();
  const { summaries, compact } = await fixture(2, { onAnswerDiscarded }, "ok");
  const adapter = async (text: string, _aggressive?: boolean, ctx?: { maxOutputTokens?: number }) => {
    if (text.includes("\n\n")) throw new SummaryRejectedError({
      reason: "length", provider: "test", maxOutputTokens: ctx?.maxOutputTokens ?? 1_024,
    });
    // Each source is 25 characters; this 24-character answer shrinks individually.
    // The joined 50-character answer and 52-character source both estimate to 13 tokens.
    return "accepted model summary!!";
  };
  const summarize = createProviderChain([() => ({ name: "test", kind: "http", summarizer: async () => adapter })]);

  const result = await compact(summarize);

  expect(result.level).toBe("fallback");
  expect(onAnswerDiscarded).toHaveBeenCalledTimes(2);
  expect((await summaries.getSummary(result.createdSummaryId!))!.content).not.toContain("accepted model summary");
});
