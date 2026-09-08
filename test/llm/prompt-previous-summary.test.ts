import { describe, it, expect } from "vitest";
import { buildSummaryPrompt, buildSummaryPromptWithSystem } from "../../src/llm/prompt.js";

/**
 * The compaction engine hands every chunk the previous chunk's summary so the
 * chunks read as one thread. It reached the provider context but was never
 * rendered into the prompt (#380).
 */
describe("buildSummaryPrompt carries the previous chunk's summary", () => {
  const PREVIOUS = "Earlier the user chose SQLite over Postgres for the event store.";

  /** The block the leaf template fills with the previous summary, or "(none)". */
  function previousContextBlock(prompt: string): string {
    return prompt.match(/<previous_context>([\s\S]*?)<\/previous_context>/)?.[1].trim() ?? "";
  }

  it("renders it into a leaf prompt in place of the empty marker", () => {
    const prompt = buildSummaryPrompt("some conversation", false, { previousSummary: PREVIOUS });
    expect(previousContextBlock(prompt)).toBe(PREVIOUS);
  });

  it("renders it into a condensed prompt", () => {
    const prompt = buildSummaryPrompt("some summaries", false, {
      isCondensed: true, depth: 1, previousSummary: PREVIOUS,
    });
    expect(prompt).toContain(PREVIOUS);
    expect(prompt).toContain("<previous_context>");
  });

  it("keeps the empty marker when there is no previous chunk", () => {
    const prompt = buildSummaryPrompt("some conversation", false, {});
    expect(previousContextBlock(prompt)).toBe("(none)");
  });

  it("reaches the CLI providers that prepend the system prompt", () => {
    const prompt = buildSummaryPromptWithSystem("some conversation", false, {
      previousSummary: PREVIOUS,
    });
    expect(prompt).toContain(PREVIOUS);
  });

  it("is left out of an alternate task prompt, which sends the text verbatim", () => {
    const prompt = buildSummaryPrompt("raw text", false, {
      taskPrompt: "do something else", previousSummary: PREVIOUS,
    });
    expect(prompt).toBe("raw text");
  });
});
