import OpenAI from "openai";
import { createClaudeProcessSummarizer } from "../../src/llm/claude-process.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import type { LcmSummarizeFn } from "../../src/llm/types.js";

export type EvalProvider = "openrouter" | "openai" | "claude-process";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The production OpenAI-compatible summarizer against any endpoint. Token and
 * cost accounting lives in production now, so the bench adds nothing but the
 * knobs production has no reason to send.
 */
function createHttpSummarizer(baseURL: string, apiKey: string, model: string): LcmSummarizeFn {
  // Reasoning models spend the whole max_tokens budget thinking and return
  // empty content; production sends no reasoning parameter unless configured,
  // so this is an explicit bench knob. LCM_EVAL_REASONING is the JSON object
  // sent as `reasoning` (e.g. {"effort":"minimal"} or {"enabled":false});
  // LCM_EVAL_REASONING_EFFORT is the shorthand for the effort form.
  const reasoning: Record<string, unknown> | undefined = process.env.LCM_EVAL_REASONING
    ? (JSON.parse(process.env.LCM_EVAL_REASONING) as Record<string, unknown>)
    : process.env.LCM_EVAL_REASONING_EFFORT
      ? { effort: process.env.LCM_EVAL_REASONING_EFFORT }
      : undefined;

  // Qwen-style servers (vLLM, MLX) take enable_thinking through
  // chat_template_kwargs, the one parameter with no production path: a client
  // override is the only place to inject it.
  let clientOverride: unknown;
  if (process.env.LCM_EVAL_DISABLE_THINKING === "1") {
    const client = new OpenAI({ baseURL, apiKey });
    clientOverride = {
      chat: {
        completions: {
          create: (params: Parameters<typeof client.chat.completions.create>[0]) =>
            client.chat.completions.create({
              ...params,
              chat_template_kwargs: { enable_thinking: false },
              stream: false,
            } as typeof params),
        },
      },
    };
  }

  return createOpenAISummarizer({ model, baseURL, apiKey, reasoning, _clientOverride: clientOverride });
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
    return createHttpSummarizer(requireEnv("LCM_EVAL_BASE_URL"), process.env.LCM_EVAL_API_KEY ?? "local", model);
  }
  return createHttpSummarizer(OPENROUTER_BASE_URL, requireEnv("OPENROUTER_API_KEY"), model);
}
