import { SummarizeJobStore } from "./summarize-jobs.js";
import { buildSummaryPrompt } from "../llm/prompt.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT, resolveTargetTokens, resolveMaxOutputTokens } from "../summarize.js";
import type { DaemonConfig } from "./config.js";
import { createClaudeProcessSummarizer } from "../llm/claude-process.js";
import { createCodexProcessSummarizer } from "../llm/codex-process.js";
import { createCopilotProcessSummarizer } from "../llm/copilot-process.js";
import { createMockSummarizer } from "../llm/mock-summarizer.js";
import type { LcmSummarizeFn } from "../llm/types.js";

export type CompactClient = "claude" | "codex" | "copilot";
export type EffectiveProvider = Exclude<DaemonConfig["llm"]["provider"], "auto">;

export function resolveEffectiveProvider(config: DaemonConfig, client?: CompactClient): EffectiveProvider {
  if (config.llm.provider === "auto") {
    if (client === "codex") return "codex-process";
    if (client === "copilot") return "copilot-process";
    return "claude-process";
  }
  return config.llm.provider;
}

export async function createSummarizer(
  provider: EffectiveProvider,
  config: DaemonConfig,
  jobs?: SummarizeJobStore,
): Promise<LcmSummarizeFn | null> {
  // Mock summarizer for E2E testing — deterministic, no LLM calls
  if (config.summarizer?.mock) return createMockSummarizer();
  if (provider === "disabled") return null;
  if (provider === "session") {
    return async (text, aggressive, ctx = {}) => {
      if (jobs && ctx.sessionId) {
        const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
          inputTokens: Math.ceil(text.length / 4), mode: aggressive ? "aggressive" : "normal",
          isCondensed: ctx.isCondensed ?? false, condensedTargetTokens: 2000,
        });
        const system = ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT;
        const prompt = buildSummaryPrompt(text, aggressive, ctx);
        const answer = await jobs.enqueue({
          session_id: ctx.sessionId, kind: ctx.isCondensed ? "condensed" : "leaf",
          depth: ctx.depth ?? (ctx.isCondensed ? 1 : 0), system, prompt, targetTokens,
          maxTokens: resolveMaxOutputTokens(targetTokens),
        });
        if (!answer.error && answer.text?.trim()) {
          const inputTokens = answer.usage?.input_tokens ?? Math.ceil((system.length + prompt.length) / 4);
          const outputTokens = answer.usage?.output_tokens ?? Math.ceil(answer.text.length / 4);
          const provider = answer.providerId ?? (ctx.isCondensed ? "session:fork" : "session:haiku");
          ctx.onUsage?.({ provider, model: provider.split(":")[1], inputTokens, outputTokens,
            tokensUsed: inputTokens + outputTokens, estimated: answer.usage?.estimated ?? true });
          return answer.text.trim();
        }
      }
      const fallbackConfig = { ...config, llm: { ...config.llm, provider: config.llm.fallbackProvider ?? "auto" as const } };
      const fallback = await createSummarizer(resolveEffectiveProvider(fallbackConfig, ctx.client), fallbackConfig);
      if (!fallback) throw new Error("Session summarizer unavailable and fallback disabled");
      return fallback(text, aggressive, ctx);
    };
  }
  // No model passed on purpose: config.llm.model is shared across providers, so
  // a model pinned for codex/openai must not leak into the claude CLI.
  if (provider === "claude-process") return createClaudeProcessSummarizer();
  if (provider === "codex-process") {
    return createCodexProcessSummarizer({ model: config.llm.model });
  }
  if (provider === "copilot-process") {
    return createCopilotProcessSummarizer({ model: config.llm.model });
  }
  if (provider === "openai") {
    const { createOpenAISummarizer } = await import("../llm/openai.js");
    return createOpenAISummarizer({
      model: config.llm.model,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      reasoning: config.llm.reasoning,
    });
  }
  // anthropic
  const { createAnthropicSummarizer } = await import("../llm/anthropic.js");
  return createAnthropicSummarizer({
    model: config.llm.model,
    apiKey: config.llm.apiKey!,
  });
}

/**
 * Creates a cached summarizer factory for a given DaemonConfig.
 * The returned function lazily creates summarizers per provider and memoizes them.
 */
export function makeSummarizerCache(config: DaemonConfig) {
  const cache = new Map<EffectiveProvider, Promise<LcmSummarizeFn | null>>();
  return (provider: EffectiveProvider): Promise<LcmSummarizeFn | null> => {
    let cached = cache.get(provider);
    if (!cached) {
      cached = createSummarizer(provider, config);
      cache.set(provider, cached);
    }
    return cached;
  };
}
