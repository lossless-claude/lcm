import Anthropic from "@anthropic-ai/sdk";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
  resolveMaxOutputTokens,
} from "../summarize.js";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";

export type { LcmSummarizeFn } from "./types.js";

type SummarizerOptions = {
  model: string;
  apiKey: string;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Anthropic reports `input_tokens` as the UNCACHED portion only, with cache
 * reads and writes counted separately. The normalized `inputTokens` is the
 * full prompt, so the three are summed and `cache_read` is the cached subset.
 * The API returns no cost figure, so `costUsd` stays absent — meaning
 * unknown, not free: the call is still charged.
 */
function toUsage(response: any, fallbackModel: string): SummarizerUsage | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  return {
    provider: "anthropic",
    model: response.model || fallbackModel,
    inputTokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    outputTokens,
    tokensUsed: inputTokens + outputTokens,
  };
}

export function createAnthropicSummarizer(opts: SummarizerOptions): LcmSummarizeFn {
  const client = opts._clientOverride ?? new Anthropic({ apiKey: opts.apiKey });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
      inputTokens: estimatedInputTokens,
      mode: aggressive ? "aggressive" : "normal",
      isCondensed: ctx.isCondensed ?? false,
      condensedTargetTokens: 2000,
    });

    const prompt = ctx.taskPrompt !== undefined ? text : ctx.isCondensed
      ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
      : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create({
          model: opts.model,
          max_tokens: resolveMaxOutputTokens(targetTokens),
          system: ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });

        // Reported before the empty-content check: those tokens were charged
        // even when the model returned nothing usable.
        const usage = toUsage(response, opts.model);
        if (usage) ctx.onUsage?.(usage);

        const textContent = response.content.find((c: any) => c.type === "text")?.text ?? "";
        // Empty content is a failure, not a summary: falling back to a slice of
        // the input would persist raw conversation text as a fake summary.
        if (!textContent) throw new Error("summarizer returned empty content");
        return textContent;
      } catch (err: any) {
        if (err?.status === 401) throw err; // auth error: no retry
        lastError = err;
        if (attempt < MAX_RETRIES - 1) await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  };
}
