import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { describe, it, expect, vi } from "vitest";
import { LCM_CONFIG_DEFAULTS, resolveLcmConfig } from "../src/db/config.js";
import { CompactionEngine, compactEngineConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const CONTEXT_TOKENS = 50_000;

function makeMinimalStores(): { conversationStore: ConversationStore; summaryStore: SummaryStore } {
  const summaryStore = {
    getContextTokenCount: vi.fn().mockResolvedValue(CONTEXT_TOKENS),
    getContextItems: vi.fn().mockResolvedValue([
      { ordinal: 0, itemType: "message", messageId: 1, summaryId: null, tokenCount: CONTEXT_TOKENS },
    ]),
    insertSummary: vi.fn().mockResolvedValue(undefined),
    linkSummaryToMessages: vi.fn().mockResolvedValue(undefined),
    replaceContextRangeWithSummary: vi.fn().mockResolvedValue(undefined),
    getDistinctDepthsInContext: vi.fn().mockResolvedValue([0]),
  } as unknown as SummaryStore;

  const conversationStore = {
    getToolLessonsForMessages: vi.fn().mockResolvedValue([]),
    isWorkerExcluded: () => false,
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

    const summarizeCalls: { previousSummary?: string; language?: string }[] = [];
    const summarize: CompactionSummarizeFn = vi.fn().mockImplementation(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { previousSummary?: string; language?: string },
      ) => {
        summarizeCalls.push({
          previousSummary: options?.previousSummary,
          language: options?.language,
        });
        return "summary content";
      }
    );

    const engine = new CompactionEngine(conversationStore, summaryStore, {
      contextThreshold: 0.5,
      freshTailCount: 0,
      leafMinFanout: 1,
      condensedMinFanout: 10,
      condensedTargetTokens: 900,
      language: "pt-BR",
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
    expect(summarizeCalls[0].language).toBe("pt-BR");
  });
});

describe("compactEngineConfig", () => {
  it("does not expose the unused hard-trigger fanout setting", () => {
    const env = { LCM_CONDENSED_MIN_FANOUT_HARD: "7" };
    expect(resolveLcmConfig(env)).not.toHaveProperty("condensedMinFanoutHard");
    expect(compactEngineConfig({ env })).not.toHaveProperty("condensedMinFanoutHard");
    expect(LCM_CONFIG_DEFAULTS).not.toHaveProperty("condensedMinFanoutHard");
  });

  it("threads through the only per-caller value", () => {
    const scrubber = {} as never;
    const config = compactEngineConfig({ scrubber, language: "pt-BR" });
    expect(config.scrubber).toBe(scrubber);
    expect(config.language).toBe("pt-BR");
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

describe("CompactionEngine fanout defaults", () => {
  it.each([
    { depth: 0, fanout: 3, key: "LCM_LEAF_MIN_FANOUT" },
    { depth: 1, fanout: 2, key: "LCM_CONDENSED_MIN_FANOUT" },
  ])("uses the configured default at depth $depth for non-positive fanout", async ({ depth, fanout, key }) => {
    const sourceTokens = 1_000;
    for (const value of ["0", "-1"]) {
      for (const count of [fanout - 1, fanout]) {
        const db = new DatabaseSync(":memory:");
        try {
          runLcmMigrations(db);
          const conversationStore = new ConversationStore(db);
          const summaryStore = new SummaryStore(db);
          const { conversationId } = await conversationStore.getOrCreateConversation("fanout-session");
          for (let i = 0; i < count; i++) {
            const summaryId = `sum_fanout_${i}`;
            await summaryStore.insertSummary({
              summaryId, conversationId, kind: depth === 0 ? "leaf" : "condensed",
              depth, content: "fact".repeat(sourceTokens), tokenCount: sourceTokens,
            });
            await summaryStore.replaceContextRangeWithSummary({
              conversationId, startOrdinal: i, endOrdinal: i, summaryId,
            });
          }
          const engine = new CompactionEngine(conversationStore, summaryStore, {
            ...compactEngineConfig({ env: { [key]: value } }), freshTailCount: 0,
          });
          const result = await engine.compact({
            conversationId, tokenBudget: CONTEXT_TOKENS, force: true,
            summarize: async () => "Condensed durable facts",
          });
          expect(result.condensed).toBe(count === fanout);
          expect((await summaryStore.getContextItems(conversationId)).length)
            .toBe(count === fanout ? 1 : count);
        } finally {
          db.close();
        }
      }
    }
  });
});
