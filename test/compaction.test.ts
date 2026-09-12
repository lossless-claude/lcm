import { describe, it, expect, vi } from "vitest";
import { LCM_CONFIG_DEFAULTS } from "../src/db/config.js";
import { CompactionEngine, compactEngineConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";

function makeMinimalStores(): { conversationStore: ConversationStore; summaryStore: SummaryStore } {
  const summaryStore = {
    getContextTokenCount: vi.fn().mockResolvedValue(50_000),
    getContextItems: vi.fn().mockResolvedValue([
      { ordinal: 0, itemType: "message", messageId: 1, summaryId: null, tokenCount: 50_000 },
    ]),
    insertSummary: vi.fn().mockResolvedValue(undefined),
    linkSummaryToMessages: vi.fn().mockResolvedValue(undefined),
    replaceContextRangeWithSummary: vi.fn().mockResolvedValue(undefined),
    getDistinctDepthsInContext: vi.fn().mockResolvedValue([0]),
  } as unknown as SummaryStore;

  const conversationStore = {
    getConversation: vi.fn().mockResolvedValue({ conversationId: 1, sessionId: "sess-1" }),
    getMaxSeq: vi.fn().mockResolvedValue(0),
    createMessage: vi.fn().mockResolvedValue({ messageId: 1 }),
    createMessageParts: vi.fn().mockResolvedValue(undefined),
    getMessageById: vi.fn().mockResolvedValue({
      messageId: 1, role: "user", content: "hello",
      createdAt: new Date(), fileIds: [],
    }),
    withTransaction: vi.fn().mockImplementation((fn: () => Promise<void>) => fn()),
  } as unknown as ConversationStore;

  return { conversationStore, summaryStore };
}

describe("CompactionEngine.compact — previousSummaryContent seeding", () => {
  it("passes previousSummaryContent to summarize on the first leaf call", async () => {
    const { conversationStore, summaryStore } = makeMinimalStores();

    const summarizeCalls: { previousSummary?: string }[] = [];
    const summarize: CompactionSummarizeFn = vi.fn().mockImplementation(
      async (_text: string, _aggressive?: boolean, options?: { previousSummary?: string }) => {
        summarizeCalls.push({ previousSummary: options?.previousSummary });
        return "summary content";
      }
    );

    const engine = new CompactionEngine(conversationStore, summaryStore, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedMinFanoutHard: 5,
      incrementalMaxDepth: 0,
      condensedTargetTokens: 900,
      maxRounds: 1,
    });

    await engine.compact({
      conversationId: 1,
      tokenBudget: 100_000,
      summarize,
      force: true,
      previousSummaryContent: "prior context",
    });

    expect(summarizeCalls.length).toBeGreaterThan(0);
    expect(summarizeCalls[0].previousSummary).toBe("prior context");
  });
});

describe("compactEngineConfig", () => {
  it("threads through the only per-caller value", () => {
    const scrubber = {} as never;
    expect(compactEngineConfig({ scrubber }).scrubber).toBe(scrubber);
    expect(compactEngineConfig().scrubber).toBeUndefined();
  });

  it("reads its knobs from the environment, and its defaults are the engine's own", () => {
    const untouched = compactEngineConfig({ env: {} });
    expect(untouched).toMatchObject(LCM_CONFIG_DEFAULTS);
    // These literals are what the engine was hardcoded to before it read the
    // environment; an unset environment must keep producing exactly them.
    expect(LCM_CONFIG_DEFAULTS).toEqual({
      contextThreshold: 0.75,
      freshTailCount: 8,
      leafMinFanout: 3,
      condensedMinFanout: 2,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20000,
      condensedTargetTokens: 900,
    });

    const tuned = compactEngineConfig({ env: { LCM_FRESH_TAIL_COUNT: "32", LCM_CONDENSED_TARGET_TOKENS: "not a number" } });
    expect(tuned.freshTailCount).toBe(32);
    // An unparsable value falls back to the default rather than poisoning the engine.
    expect(tuned.condensedTargetTokens).toBe(LCM_CONFIG_DEFAULTS.condensedTargetTokens);
  });

  it("is the same engine for every caller, so the bench cannot drift from /compact", () => {
    // Only the scrubber may differ between the daemon route and the summarizer
    // bench; everything else must come out identical.
    const route = compactEngineConfig({ scrubber: {} as never });
    const bench = compactEngineConfig();
    const { scrubber: _b, ...routeRest } = route;
    const { scrubber: _d, ...benchRest } = bench;
    expect(benchRest).toEqual(routeRest);
  });
});
