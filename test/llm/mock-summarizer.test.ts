import { describe, it, expect } from "vitest";
import { createMockSummarizer } from "../../src/llm/mock-summarizer.js";

describe("createMockSummarizer", () => {
  it("returns structurally valid summary text (non-empty string)", async () => {
    const summarizer = createMockSummarizer();
    const result = await summarizer("Test input text for summarization");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same input (call twice, same result)", async () => {
    const summarizer = createMockSummarizer();
    const text = "PostgreSQL database with concurrent transactions";
    const result1 = await summarizer(text);
    const result2 = await summarizer(text);
    expect(result1).toBe(result2);
  });

  it("includes content-derived keywords in output (input 'PostgreSQL' → output mentions it)", async () => {
    const summarizer = createMockSummarizer();
    const input = "PostgreSQL is a relational database management system";
    const result = await summarizer(input);
    // Should include first sentence or key content
    expect(result.toLowerCase()).toContain("postgresql");
  });

  it("matches LcmSummarizeFn signature (accepts aggressive and ctx params)", async () => {
    const summarizer = createMockSummarizer();
    // Test with aggressive=true
    const result1 = await summarizer("Test input", true);
    expect(result1).toBeTruthy();
    // Test with aggressive=false
    const result2 = await summarizer("Test input", false);
    expect(result2).toBeTruthy();
    // Test with context object
    const result3 = await summarizer("Test input", true, {
      isCondensed: true,
      targetTokens: 100,
      depth: 2,
    });
    expect(result3).toBeTruthy();
    // All with same input should be deterministic
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it("handles empty input gracefully", async () => {
    const summarizer = createMockSummarizer();
    const result = await summarizer("");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("handles multiline input", async () => {
    const summarizer = createMockSummarizer();
    const multilineText = "Line 1\nLine 2\nLine 3";
    const result = await summarizer(multilineText);
    expect(result).toBeTruthy();
    expect(result).toContain("Line 1");
  });
});
