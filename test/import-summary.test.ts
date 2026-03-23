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
});
