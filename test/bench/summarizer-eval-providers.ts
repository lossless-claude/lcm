import OpenAI from "openai";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "../../src/llm/types.js";

export type EvalProvider = "openrouter" | "openai" | "claude-process";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The production OpenAI-compatible summarizer against any endpoint, with the
 * response usage captured through the client override so the bench can report
 * tokens without changing production code.
 */
function createHttpSummarizer(label: string, baseURL: string, apiKey: string, model: string): LcmSummarizeFn {
  const client = new OpenAI({ baseURL, apiKey });
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
              provider: label,
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

  const inner = createOpenAISummarizer({ model, baseURL, apiKey, _clientOverride: capturing });
  return async (text, aggressive, ctx = {}) => {
    pendingCtx = ctx;
    try {
      return await inner(text, aggressive, ctx);
    } finally {
      pendingCtx = undefined;
    }
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createEvalSummarizer(provider: EvalProvider, model: string): LcmSummarizeFn {
  if (provider === "claude-process") return createClaudeProcessSummarizer({ model });
  if (provider === "openai") {
    // Any OpenAI-compatible server, e.g. a local MLX box: LCM_EVAL_BASE_URL + LCM_EVAL_API_KEY.
    return createHttpSummarizer("openai", requireEnv("LCM_EVAL_BASE_URL"), process.env.LCM_EVAL_API_KEY ?? "local", model);
  }
  return createHttpSummarizer("openrouter", OPENROUTER_BASE_URL, requireEnv("OPENROUTER_API_KEY"), model);
}
