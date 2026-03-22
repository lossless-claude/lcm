import type { DaemonConfig } from "./config.js";
import { createClaudeProcessSummarizer } from "../llm/claude-process.js";
import { createCodexProcessSummarizer } from "../llm/codex-process.js";
import type { LcmSummarizeFn } from "../llm/types.js";

export type CompactClient = "claude" | "codex";
export type EffectiveProvider = Exclude<DaemonConfig["llm"]["provider"], "auto">;

export function resolveEffectiveProvider(config: DaemonConfig, client?: CompactClient): EffectiveProvider {
  if (config.llm.provider === "auto") {
    return client === "codex" ? "codex-process" : "claude-process";
  }
  return config.llm.provider;
}

export async function createSummarizer(
  provider: EffectiveProvider,
  config: DaemonConfig,
): Promise<LcmSummarizeFn | null> {
  if (provider === "disabled") return null;
  if (provider === "claude-process") return createClaudeProcessSummarizer();
  if (provider === "codex-process") {
    return createCodexProcessSummarizer({ model: config.llm.model });
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
