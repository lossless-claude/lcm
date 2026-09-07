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
): Promise<LcmSummarizeFn | null> {
  // Mock summarizer for E2E testing — deterministic, no LLM calls
  if (config.summarizer?.mock) return createMockSummarizer();
  if (provider === "disabled") return null;
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
