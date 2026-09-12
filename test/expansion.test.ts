import { describe, expect, it, vi } from "vitest";
import type { ExpansionOrchestrator } from "../src/expansion.js";
import { buildExpansionToolDefinition } from "../src/expansion.js";

const MAX_EXPAND_TOKENS = 250;

function makeExpansionResult() {
  return {
    expansions: [],
    citedIds: [],
    totalTokens: 0,
    truncated: false,
  };
}

describe("buildExpansionToolDefinition tokenCap bounds", () => {
  it("defaults omitted tokenCap for summary expansion to maxExpandTokens", async () => {
    const orchestrator = {
      expand: vi.fn().mockResolvedValue(makeExpansionResult()),
      describeAndExpand: vi.fn().mockResolvedValue(makeExpansionResult()),
    };

    const tool = buildExpansionToolDefinition({
      orchestrator: orchestrator as unknown as ExpansionOrchestrator,
      maxExpandTokens: MAX_EXPAND_TOKENS,
      conversationId: 12,
    });

    await tool.execute("call-1", {
      summaryIds: ["sum_a"],
    });

    expect(orchestrator.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryIds: ["sum_a"],
        tokenCap: 250,
      }),
    );
  });

  it("clamps oversized tokenCap for query expansion to maxExpandTokens", async () => {
    const orchestrator = {
      expand: vi.fn().mockResolvedValue(makeExpansionResult()),
      describeAndExpand: vi.fn().mockResolvedValue(makeExpansionResult()),
    };

    const tool = buildExpansionToolDefinition({
      orchestrator: orchestrator as unknown as ExpansionOrchestrator,
      maxExpandTokens: MAX_EXPAND_TOKENS,
      conversationId: 99,
    });

    await tool.execute("call-2", {
      query: "keyword",
      tokenCap: 5_000,
    });

    expect(orchestrator.describeAndExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "keyword",
        tokenCap: 250,
      }),
    );
  });
});
