import { describe, it, expect, vi, afterEach } from "vitest";
import { printImportSummary } from "../src/import-summary.js";
import type { ImportResult } from "../src/import.js";

describe("printImportSummary", () => {
  const logs: string[] = [];
  const origLog = console.log;

  afterEach(() => {
    console.log = origLog;
    logs.length = 0;
  });

  function capture() {
    console.log = vi.fn((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }

  function baseResult(overrides: Partial<ImportResult> = {}): ImportResult {
    return {
      imported: 3,
      skippedEmpty: 1,
      failed: 0,
      totalMessages: 15,
      totalTokens: 50000,
      tokensAfter: 0,
      ...overrides,
    };
  }

  it("shows basic session counts and token summary", () => {
    capture();
    printImportSummary(baseResult());
    expect(logs.some(l => l.includes("3 sessions imported"))).toBe(true);
    expect(logs.some(l => l.includes("1 skipped"))).toBe(true);
    expect(logs.some(l => l.includes("Tokens ingested"))).toBe(true);
    expect(logs.some(l => l.includes("50.0k"))).toBe(true);
  });

  it("shows compression stats in replay mode", () => {
    capture();
    printImportSummary(baseResult({ tokensAfter: 2000 }), { replay: true });
    expect(logs.some(l => l.includes("Tokens after"))).toBe(true);
    expect(logs.some(l => l.includes("Compression ratio"))).toBe(true);
    expect(logs.some(l => l.includes("Tokens freed"))).toBe(true);
    expect(logs.some(l => l.includes("[replay]"))).toBe(true);
  });

  it("shows replay token receipt when replay usage is available", () => {
    capture();
    printImportSummary(
      baseResult({
        replayUsage: {
          provider: "codex-process",
          model: "gpt-5.6-luna",
          calls: 4,
          okCalls: 3,
          failedCalls: 1,
          tokensSpent: 144000,
          callsWithCost: 0,
        },
      }),
      { replay: true },
    );
    expect(logs.some((l) => l.includes("Summarizer") && l.includes("codex-process / gpt-5.6-luna"))).toBe(true);
    expect(logs.some((l) => l.includes("Calls") && l.includes("4 (3 ok, 1 failed)"))).toBe(true);
    expect(logs.some((l) => l.includes("Tokens spent") && l.includes("144.0k"))).toBe(true);
    expect(logs.some((l) => l.includes("Avg per session") && l.includes("36.0k"))).toBe(true);
  });

  it("omits compression stats when not in replay mode", () => {
    capture();
    printImportSummary(baseResult({ tokensAfter: 2000 }));
    expect(logs.some(l => l.includes("Tokens after"))).toBe(false);
    expect(logs.some(l => l.includes("Compression ratio"))).toBe(false);
  });

  it("omits compression stats when tokensAfter equals totalTokens (no savings) in replay mode", () => {
    capture();
    // tokensAfter === totalTokens means compact ran but produced no savings — omit compression rows
    printImportSummary(baseResult({ totalTokens: 50000, tokensAfter: 50000 }), { replay: true });
    expect(logs.some(l => l.includes("Tokens after"))).toBe(false);
    expect(logs.some(l => l.includes("Compression ratio"))).toBe(false);
  });

  it("does not show failed count when 0", () => {
    capture();
    printImportSummary(baseResult({ failed: 0 }));
    expect(logs.some(l => l.includes("failed"))).toBe(false);
  });

  it("shows failed count when > 0", () => {
    capture();
    printImportSummary(baseResult({ failed: 2 }));
    expect(logs.some(l => l.includes("2 failed"))).toBe(true);
  });

  it("does not show token summary when totalTokens is 0", () => {
    capture();
    printImportSummary(baseResult({ totalTokens: 0 }));
    expect(logs.some(l => l.includes("Tokens ingested"))).toBe(false);
    expect(logs.some(l => l.includes("Sessions processed"))).toBe(false);
  });
  it("prints the cost with enough precision that a sub-cent charge is visible", () => {
    capture();
    printImportSummary(
      baseResult({
        replayUsage: {
          provider: "openai", model: "z-ai/glm-5.3-flash",
          calls: 4, okCalls: 4, failedCalls: 0, tokensSpent: 144000,
          costUsd: 0.000082, callsWithCost: 4,
        },
      }),
      { replay: true },
    );
    const cost = logs.find((l) => l.includes("Cost"));
    // Two decimals would render this real charge as "$0.00".
    expect(cost).toContain("$0.000082");
    expect(cost).toContain("4 of 4 calls priced");
  });

  it("says unknown, never $0.00, when no call reported a price", () => {
    capture();
    printImportSummary(
      baseResult({
        replayUsage: {
          provider: "anthropic", model: "claude-haiku-4-5-20251001",
          calls: 4, okCalls: 4, failedCalls: 0, tokensSpent: 144000,
          callsWithCost: 0,
        },
      }),
      { replay: true },
    );
    const cost = logs.find((l) => l.includes("Cost"));
    expect(cost).toContain("unknown");
    expect(cost).toContain("0 of 4 calls priced");
    expect(cost).not.toContain("$");
  });

  it("flags a partially priced run rather than passing it off as the full cost", () => {
    capture();
    printImportSummary(
      baseResult({
        replayUsage: {
          provider: "mixed", model: "mixed",
          calls: 10, okCalls: 10, failedCalls: 0, tokensSpent: 144000,
          costUsd: 0.0005, callsWithCost: 3,
        },
      }),
      { replay: true },
    );
    expect(logs.find((l) => l.includes("Cost"))).toContain("3 of 10 calls priced");
  });
});
