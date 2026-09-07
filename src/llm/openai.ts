import OpenAI from "openai";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
  resolveMaxOutputTokens,
} from "../summarize.js";

type OpenAISummarizerOptions = {
  model: string;
  baseURL: string;
  apiKey?: string;
  reasoning?: Record<string, unknown>;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Every provider charges; OpenRouter is the only OpenAI-compatible endpoint
 * that REPORTS the charge back (`usage.cost`), and only when the request opts
 * in. Plain servers reject unknown top-level fields, so the flag is host-scoped.
 */
function isOpenRouter(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

/**
 * OpenAI reports `cached_tokens` as a SUBSET of `prompt_tokens`, which is
 * already the normalized convention: no re-basing needed, unlike Anthropic.
 */
function toUsage(response: any, fallbackModel: string): SummarizerUsage | undefined {
  const usage = response?.usage;
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  return {
    provider: "openai",
    model: response.model || fallbackModel,
    inputTokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
    outputTokens,
    tokensUsed: usage.total_tokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    // Absent stays absent: a consumer must read it as "unknown", not "free".
    costUsd: typeof usage.cost === "number" ? usage.cost : undefined,
  };
}

export function createOpenAISummarizer(opts: OpenAISummarizerOptions): LcmSummarizeFn {
  const client =
    opts._clientOverride ??
    new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey || "local", // many local servers require a non-empty key
    });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;
  const askForCostAccounting = isOpenRouter(opts.baseURL);

  return async function summarize(text, aggressive, ctx: SummarizeContext = {}): Promise<string> {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens =
      ctx.targetTokens ??
      resolveTargetTokens({
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
        const response = await client.chat.completions.create({
          model: opts.model,
          // `reasoning` is provider-specific and absent from the OpenAI SDK types;
          // omitted entirely when unset so servers rejecting unknown fields keep working.
          ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
          ...(askForCostAccounting ? { usage: { include: true } } : {}),
          max_tokens: resolveMaxOutputTokens(targetTokens),
          // Merge system content into user message for compatibility with local
          // servers (e.g. MLX/llama.cpp) that don't support role:"system".
          messages: [
            { role: "user", content: `${ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT}\n\n${prompt}` },
          ],
        });

        // Reported before the empty-content check: a reasoning model that
        // spends the whole budget thinking still charged for those tokens.
        const usage = toUsage(response, opts.model);
        if (usage) ctx.onUsage?.(usage);

        const textContent = response.choices[0]?.message?.content ?? "";
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
