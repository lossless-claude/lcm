import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";
import type { LcmSummarizeFn } from "../../src/llm/types.js";

export type EvalProvider = "openrouter" | "openai" | "claude-process";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/** The endpoint name the eval config declares; usage is reported under it. */
const EVAL_ENDPOINT = "eval";

/**
 * Request fields production sends only when an endpoint's `body` holds them, so
 * the bench sets them from the environment. Reasoning models spend the whole
 * max_tokens budget thinking and return empty content without them.
 * - LCM_EVAL_REASONING: the JSON object sent as `reasoning` (e.g. {"effort":"minimal"} or {"enabled":false});
 *   LCM_EVAL_REASONING_EFFORT is the shorthand for the effort form.
 * - LCM_EVAL_DISABLE_THINKING=1: `chat_template_kwargs.enable_thinking=false`, for Qwen-style servers (vLLM, MLX).
 */
function evalRequestBody(): Record<string, unknown> | undefined {
  const reasoning: Record<string, unknown> | undefined = process.env.LCM_EVAL_REASONING
    ? (JSON.parse(process.env.LCM_EVAL_REASONING) as Record<string, unknown>)
    : process.env.LCM_EVAL_REASONING_EFFORT
      ? { effort: process.env.LCM_EVAL_REASONING_EFFORT }
      : undefined;
  const body = {
    ...(reasoning ? { reasoning } : {}),
    ...(process.env.LCM_EVAL_DISABLE_THINKING === "1" ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function evalEndpoint(provider: EvalProvider, model: string): Record<string, unknown> {
  if (provider === "claude-process") return { type: "claude-process", model };
  const body = evalRequestBody();
  const connection = provider === "openai"
    // Any OpenAI-compatible server, e.g. a local MLX box: LCM_EVAL_BASE_URL + LCM_EVAL_API_KEY.
    ? { baseURL: requireEnv("LCM_EVAL_BASE_URL"), apiKey: process.env.LCM_EVAL_API_KEY ?? "local" }
    : { baseURL: OPENROUTER_BASE_URL, apiKey: requireEnv("OPENROUTER_API_KEY") };
  return { type: "openai", model, ...connection, ...(body ? { body } : {}) };
}

/** The production summarizer factory, over one named endpoint built from the eval environment. */
export async function createEvalSummarizer(provider: EvalProvider, model: string): Promise<LcmSummarizeFn> {
  const config = loadDaemonConfig("/nonexistent", {
    llm: { provider: EVAL_ENDPOINT, providers: { [EVAL_ENDPOINT]: evalEndpoint(provider, model) } },
  }, {});
  const summarize = await createSummarizer(EVAL_ENDPOINT, config);
  if (!summarize) throw new Error("the eval endpoint produced no summarizer");
  return summarize;
}
