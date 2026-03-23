import type { LcmSummarizeFn, SummarizeContext } from "./types.js";

/**
 * Deterministic mock summarizer for E2E testing.
 * Produces structurally valid summaries by extracting key phrases from input
 * and wrapping them in a canned template. No LLM calls.
 *
 * Must match LcmSummarizeFn signature: (text, aggressive?, ctx?) => Promise<string>
 */
export function createMockSummarizer(): LcmSummarizeFn {
  return async (text: string, _aggressive?: boolean, _ctx?: SummarizeContext): Promise<string> => {
    // Extract first sentence or first 200 chars as "summary"
    const firstSentence = text.split(/[.!?\n]/)[0]?.trim() || text.slice(0, 200);
    // Deterministic hash for consistent output
    const hash = Array.from(text).reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
    return `[Mock Summary ${Math.abs(hash).toString(16).slice(0, 6)}] ${firstSentence}`;
  };
}
