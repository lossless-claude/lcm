import OpenAI from "openai";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "../../src/llm/types.js";

export type EvalProvider = "openrouter" | "claude-process";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The production OpenAI-compatible summarizer, pointed at OpenRouter, with the
 * response usage captured through the client override so the bench can report
 * tokens without changing production code.
 */
function createOpenRouterSummarizer(model: string): LcmSummarizeFn {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const client = new OpenAI({ baseURL: OPENROUTER_BASE_URL, apiKey });
  // Reasoning models spend the whole max_tokens budget thinking and return
  // empty content; production sends no reasoning parameter, so this is an
  // explicit bench knob (LCM_EVAL_REASONING_EFFORT, e.g. "minimal"), not a
  // prod mirror.
  const reasoningEffort = process.env.LCM_EVAL_REASONING_EFFORT;

  let pendingCtx: SummarizeContext | undefined;
  const capturing = {
    chat: {
      completions: {
        create: async (params: Parameters<typeof client.chat.completions.create>[0]) => {
          const reasoning = reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {};
          const response = await client.chat.completions.create({ ...params, ...reasoning, stream: false });
          const usage = response.usage;
          if (usage && pendingCtx?.onUsage) {
            const cached = (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens;
            // Provider label is wider than the production union; the bench
            // only reads the numbers and the model.
            pendingCtx.onUsage({
              provider: "openrouter",
              model: response.model ?? model,
              inputTokens: usage.prompt_tokens,
              cachedInputTokens: cached,
              outputTokens: usage.completion_tokens,
              tokensUsed: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
            } as unknown as SummarizerUsage);
          }
          return response;
        },
      },
    },
  };

  const inner = createOpenAISummarizer({ model, baseURL: OPENROUTER_BASE_URL, apiKey, _clientOverride: capturing });
  return async (text, aggressive, ctx = {}) => {
    pendingCtx = ctx;
    try {
      return await inner(text, aggressive, ctx);
    } finally {
      pendingCtx = undefined;
    }
  };
}

export function createEvalSummarizer(provider: EvalProvider, model: string): LcmSummarizeFn {
  if (provider === "claude-process") return createClaudeProcessSummarizer({ model });
  return createOpenRouterSummarizer(model);
}
