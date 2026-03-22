import { describe, it, expect, vi, afterEach } from "vitest";
import { formatNumber, printStats } from "../src/stats.js";

describe("formatNumber", () => {
  it("returns plain digits for numbers below 1000", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1)).toBe("1");
    expect(formatNumber(999)).toBe("999");
  });

  it("formats thousands with lowercase k suffix", () => {
    expect(formatNumber(1_000)).toBe("1.0k");
    expect(formatNumber(1_500)).toBe("1.5k");
    expect(formatNumber(42_000)).toBe("42.0k");
  });

  it("formats millions with M suffix", () => {
    expect(formatNumber(1_000_000)).toBe("1.0M");
    expect(formatNumber(2_500_000)).toBe("2.5M");
  });

  it("M threshold takes priority over k", () => {
    // 1,000,000 should be "1.0M" not "1000.0k"
    expect(formatNumber(1_000_000)).toMatch(/M$/);
  });
});

describe("printStats", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function captureLog(fn: () => void): string {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => lines.push(args.join(" ")));
    fn();
    return lines.join("\n");
  }

  const baseStats = {
    projects: 2,
    conversations: 5,
    compactedConversations: 3,
    messages: 150,
    summaries: 0,
    maxDepth: 0,
    rawTokens: 0,
    summaryTokens: 0,
    ratio: 0,
    promotedCount: 0,
    conversationDetails: [],
    redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
  };

  it("prints the lossless-claude header", () => {
    const out = captureLog(() => printStats(baseStats, false));
    expect(out).toContain("lossless-claude");
  });

  it("prints Memory section with project and message counts", () => {
    const out = captureLog(() => printStats(baseStats, false));
    expect(out).toContain("Memory");
    expect(out).toContain("2"); // projects
    expect(out).toContain("150"); // messages
  });

  it("omits Compression section when no summaries exist", () => {
    const out = captureLog(() => printStats({ ...baseStats, summaries: 0 }, false));
    expect(out).not.toContain("Compression");
  });

  it("prints Compression section when summaries exist", () => {
    const out = captureLog(() => printStats({
      ...baseStats,
      summaries: 5,
      rawTokens: 10_000,
      summaryTokens: 1_000,
      ratio: 10,
      compactedConversations: 2,
    }, false));
    expect(out).toContain("Compression");
    expect(out).toContain("compressed");
  });

  it("prints compression ratio and token counts", () => {
    const out = captureLog(() => printStats({
      ...baseStats,
      summaries: 3,
      rawTokens: 10_000,
      summaryTokens: 1_000,
      ratio: 10,
      compactedConversations: 2,
    }, false));
    expect(out).toContain("10.0k"); // rawTokens formatted
    expect(out).toContain("1.0k");  // summaryTokens formatted
    expect(out).toContain("90.0% compressed");
  });

  it("does not print Per Conversation section in non-verbose mode", () => {
    const out = captureLog(() => printStats({
      ...baseStats,
      summaries: 3,
      rawTokens: 5_000,
      summaryTokens: 500,
      ratio: 10,
      conversationDetails: [{ conversationId: 1, messages: 10, summaries: 2, maxDepth: 1, rawTokens: 5000, summaryTokens: 500, ratio: 10, promotedCount: 0 }],
    }, false));
    expect(out).not.toContain("Per Conversation");
  });

  it("prints Per Conversation section in verbose mode when compacted details exist", () => {
    const out = captureLog(() => printStats({
      ...baseStats,
      summaries: 3,
      rawTokens: 5_000,
      summaryTokens: 500,
      ratio: 10,
      conversationDetails: [{ conversationId: 1, messages: 10, summaries: 2, maxDepth: 1, rawTokens: 5000, summaryTokens: 500, ratio: 10, promotedCount: 0 }],
    }, true));
    expect(out).toContain("Per Conversation");
  });

  it("prints Security section with zero redactions", () => {
    const out = captureLog(() => printStats(baseStats, false));
    expect(out).toContain("Security");
    expect(out).toContain("redactions");
  });

  it("prints Security section with redaction counts breakdown", () => {
    const out = captureLog(() => printStats({
      ...baseStats,
      redactionCounts: { builtIn: 10, global: 2, project: 1, total: 13 },
    }, false));
    expect(out).toContain("Security");
    expect(out).toContain("13 total");
    expect(out).toContain("built-in: 10");
    expect(out).toContain("global: 2");
    expect(out).toContain("project: 1");
  });
});
