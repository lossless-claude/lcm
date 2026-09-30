import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  resolveTargetTokens,
  resolveMaxOutputTokens,
} from "../summarize.js";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { buildSummaryPrompt } from "./prompt.js";
import { acceptSummaryText, SummaryRejectedError } from "./summary-rejection.js";
import { DEFAULT_HTTP_TIMEOUT_MS, isRequestTimeout, withRequestDeadline } from "./http-timeout.js";
import { completionFetch } from "./http-fetch.js";
import { withEndpointSlot } from "./endpoint-concurrency.js";

export type { LcmSummarizeFn } from "./types.js";

type SummarizerOptions = {
  model: string;
  apiKey: string;
  baseURL?: string;
  /** Extra top-level request fields, validated at config load. */
  body?: Record<string, unknown>;
  /** Names this endpoint in a rejection; the provider type when unset. */
  label?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A 4xx other than a timeout or a rate limit: a refused key or request, not a transient failure. */
function isClientError(err: any): boolean {
  const status = err?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
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
  // This SDK version types fetch with node-fetch shims; JSON requests use the web API.
  const client = opts._clientOverride ?? new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 0, fetch: completionFetch as unknown as ClientOptions["fetch"] });
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

    const prompt = buildSummaryPrompt(text, aggressive, { ...ctx, targetTokens });
    const maxOutputTokens = ctx.maxOutputTokens ?? resolveMaxOutputTokens(targetTokens);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
        const response = await withEndpointSlot(opts.label ?? "anthropic", opts.maxConcurrent, timeoutMs, () => withRequestDeadline<any>(timeoutMs, (options) => client.messages.create({
          ...opts.body, // first, so every field generated below wins
          model: opts.model,
          max_tokens: maxOutputTokens,
          system: ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        }, options)), ctx.workClass);

        // Reported before the answer is judged: those tokens were charged
        // even when the model returned nothing usable.
        const usage = toUsage(response, opts.model);
        if (usage) ctx.onUsage?.(usage);

        // A max_tokens stop is a cut-off tail, not a summary, however readable it looks.
        if (response.stop_reason === "max_tokens") {
          throw new SummaryRejectedError({
            reason: "max_tokens", provider: opts.label ?? "anthropic", model: usage?.model ?? opts.model, maxOutputTokens,
          });
        }
        const textContent = response.content.find((c: any) => c.type === "text")?.text ?? "";
        // Empty content is a failure, not a summary: falling back to a slice of
        // the input would persist raw conversation text as a fake summary.
        return acceptSummaryText(textContent, opts.label ?? "anthropic", usage?.model ?? opts.model);
      } catch (err: any) {
        if (isRequestTimeout(err)) throw err;
        if (isClientError(err)) throw err; // the same request fails the same way: no retry
        if (err instanceof SummaryRejectedError && !err.retryable) throw err;
        lastError = err;
        if (attempt < MAX_RETRIES - 1) await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  };
}
