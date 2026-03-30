import { describe, it, expect } from "vitest";
import {
  buildLikeSearchPlan,
  createFallbackSnippet,
} from "../../src/store/full-text-fallback.js";

describe("buildLikeSearchPlan", () => {
  it("extracts simple single-word query", () => {
    const plan = buildLikeSearchPlan("content", "hello");
    expect(plan.terms).toEqual(["hello"]);
    expect(plan.where).toEqual([`LOWER(content) LIKE ? ESCAPE '\\'`]);
    expect(plan.args).toEqual(["%hello%"]);
  });

  it("extracts multiple words as separate terms", () => {
    const plan = buildLikeSearchPlan("content", "foo bar baz");
    expect(plan.terms).toEqual(["foo", "bar", "baz"]);
    expect(plan.args).toHaveLength(3);
    expect(plan.args[0]).toBe("%foo%");
    expect(plan.args[1]).toBe("%bar%");
    expect(plan.args[2]).toBe("%baz%");
  });

  it("handles quoted phrases as single terms", () => {
    const plan = buildLikeSearchPlan("content", '"hello world"');
    expect(plan.terms).toEqual(["hello world"]);
    expect(plan.args).toEqual(["%hello world%"]);
  });

  it("normalizes terms to lowercase", () => {
    const plan = buildLikeSearchPlan("content", "Hello WORLD");
    expect(plan.terms).toEqual(["hello", "world"]);
  });

  it("strips leading and trailing punctuation from terms", () => {
    const plan = buildLikeSearchPlan("content", "(example)");
    expect(plan.terms).toEqual(["example"]);
  });

  it("deduplicates repeated terms", () => {
    const plan = buildLikeSearchPlan("content", "foo foo bar foo");
    expect(plan.terms).toEqual(["foo", "bar"]);
  });

  it("escapes LIKE special characters in args", () => {
    // "%" is NOT in the edge-punctuation strip set, so "50%" stays as-is
    // and its "%" must be backslash-escaped in the LIKE pattern
    const plan = buildLikeSearchPlan("content", "50%");
    expect(plan.terms).toEqual(["50%"]);
    expect(plan.args[0]).toBe("%50\\%%");
  });

  it("escapes underscore in LIKE args", () => {
    // "_" is not edge punctuation so it stays inside the term
    const plan = buildLikeSearchPlan("content", "snake_case");
    expect(plan.args[0]).toBe("%snake\\_case%");
  });

  it("escapes backslash in LIKE args", () => {
    // "C:\Users" — backslash in the term must be doubled in the LIKE pattern
    const plan = buildLikeSearchPlan("content", "C:\\Users");
    expect(plan.args[0]).toBe("%c:\\\\users%");
  });

  it("returns empty plan for whitespace-only query", () => {
    const plan = buildLikeSearchPlan("content", "   ");
    expect(plan.terms).toEqual([]);
    expect(plan.where).toEqual([]);
    expect(plan.args).toEqual([]);
  });

  it("returns empty plan for empty string", () => {
    const plan = buildLikeSearchPlan("content", "");
    expect(plan.terms).toEqual([]);
  });

  it("uses the column name in WHERE clauses", () => {
    const plan = buildLikeSearchPlan("my_column", "test");
    expect(plan.where[0]).toContain("my_column");
  });

  it("where and args arrays have the same length as terms", () => {
    const plan = buildLikeSearchPlan("content", "alpha beta gamma");
    expect(plan.where).toHaveLength(plan.terms.length);
    expect(plan.args).toHaveLength(plan.terms.length);
  });
});

describe("createFallbackSnippet", () => {
  it("returns full content when it is short and no match", () => {
    const result = createFallbackSnippet("short text", ["missing"]);
    expect(result).toBe("short text");
  });

  it("truncates long content with ellipsis when no match", () => {
    const longContent = "a".repeat(100);
    const result = createFallbackSnippet(longContent, ["missing"]);
    expect(result).toMatch(/\.\.\.$/);
    expect(result.length).toBeLessThanOrEqual(83); // 77 chars + "..."
  });

  it("returns a snippet centered on the matched term", () => {
    const content = "The quick brown fox jumps over the lazy dog";
    const result = createFallbackSnippet(content, ["fox"]);
    expect(result).toContain("fox");
  });

  it("adds leading ellipsis when match is not near the start", () => {
    const prefix = "x".repeat(50);
    const content = `${prefix} target word here and after`;
    const result = createFallbackSnippet(content, ["target"]);
    expect(result).toMatch(/^\.\.\./);
    expect(result).toContain("target");
  });

  it("adds trailing ellipsis when match is not near the end", () => {
    const suffix = "x".repeat(100);
    const content = `target word here ${suffix}`;
    const result = createFallbackSnippet(content, ["target"]);
    expect(result).toMatch(/\.\.\.$/);
    expect(result).toContain("target");
  });

  it("picks the earliest matching term among multiple candidates", () => {
    const content = "alpha comes before beta in this sentence";
    // "beta" appears later but "alpha" appears first
    const result = createFallbackSnippet(content, ["beta", "alpha"]);
    // Snippet should start closer to "alpha"
    const alphaIdx = result.indexOf("alpha");
    const betaIdx = result.indexOf("beta");
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(betaIdx === -1 ? Infinity : betaIdx);
  });

  it("handles empty terms array gracefully", () => {
    const result = createFallbackSnippet("some content", []);
    // Falls back to head truncation — no crash
    expect(typeof result).toBe("string");
  });

  it("is case-insensitive when finding matches", () => {
    const content = "The QUICK brown fox";
    // terms are expected to be lowercase (as produced by buildLikeSearchPlan)
    const result = createFallbackSnippet(content, ["quick"]);
    expect(result).toContain("QUICK");
  });
});
