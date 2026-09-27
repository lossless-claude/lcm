import { SummarizeJobStore } from "./summarize-jobs.js";
import { buildSummaryPrompt } from "../llm/prompt.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT, resolveTargetTokens, resolveMaxOutputTokens } from "../summarize.js";
import type { DaemonConfig } from "./config.js";
import type { LcmPaths } from "../lcm-paths.js";
import { projectAuthorLanguage } from "../search/pivot-language.js";
import { parseLanguageTag } from "../search/language.js";
import { createClaudeProcessSummarizer } from "../llm/claude-process.js";
import { createCodexProcessSummarizer } from "../llm/codex-process.js";
import { createCopilotProcessSummarizer } from "../llm/copilot-process.js";
import { createMockSummarizer } from "../llm/mock-summarizer.js";
import type { LcmSummarizeFn } from "../llm/types.js";
import { acceptSummaryText, SummaryRejectedError } from "../llm/summary-rejection.js";
import type { SessionClient } from "../session-client.js";

/** The client a /compact call came from; copilot never calls, but its summarizer can be pinned by name. */
export type CompactClient = SessionClient | "copilot";
export type EffectiveProvider = Exclude<DaemonConfig["llm"]["provider"], "auto">;

function configuredSummarizerLanguage(config: DaemonConfig): string | undefined {
  const language = config.summarizer?.language;
  if (language === undefined) return undefined;
  if (typeof language !== "string" || !language.trim()) {
    throw new Error("Invalid summarizer.language: expected a non-empty BCP 47 language tag");
  }
  const parsed = parseLanguageTag(language);
  if (!parsed) throw new Error(`Invalid summarizer.language: "${language}" is not a BCP 47 language tag`);
  return parsed;
}

/** Resolve the language used for newly generated summaries. */
export function resolveSummarizerLanguage(
  config: DaemonConfig,
  cwd: string,
  paths: LcmPaths,
): string | undefined {
  return configuredSummarizerLanguage(config) ?? projectAuthorLanguage(cwd, paths);
}

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
  const configuredLanguage = configuredSummarizerLanguage(config);
  const withConfiguredLanguage = (summarizer: LcmSummarizeFn): LcmSummarizeFn => {
    if (!configuredLanguage) return summarizer;
    return async (text, aggressive, ctx = {}) =>
      summarizer(text, aggressive, { ...ctx, language: configuredLanguage });
  };

  // Mock summarizer for E2E testing — deterministic, no LLM calls
  if (config.summarizer?.mock) return withConfiguredLanguage(createMockSummarizer());
  if (provider === "disabled") return null;
  if (provider === "session") {
    return withConfiguredLanguage(async (text, aggressive, ctx = {}) => {
      let sessionMissReason = "no live session job queue";
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
        for (const attempt of answer.usageAttempts ?? []) {
          ctx.onUsage?.({ provider: attempt.providerId, model: attempt.providerId.split(":")[1],
            inputTokens: attempt.usage.input_tokens, outputTokens: attempt.usage.output_tokens,
            tokensUsed: attempt.usage.input_tokens + attempt.usage.output_tokens,
            estimated: attempt.usage.estimated, failed: attempt.failed ?? true });
        }
        if (answer.error) {
          sessionMissReason = String(answer.error);
        } else {
          const text = answer.text ?? "";
          const inputTokens = answer.usage?.input_tokens ?? Math.ceil((system.length + prompt.length) / 4);
          const outputTokens = answer.usage?.output_tokens ?? Math.ceil(text.length / 4);
          const provider = answer.providerId ?? (ctx.isCondensed ? "session:fork" : "session:haiku");
          // Reported before the answer is judged: a rejected answer was still charged.
          ctx.onUsage?.({ provider, model: provider.split(":")[1], inputTokens, outputTokens,
            tokensUsed: inputTokens + outputTokens, estimated: answer.usage?.estimated ?? true });
          try {
            return acceptSummaryText(text, provider).trim();
          } catch (err) {
            // A rejected answer goes to the fallback like an error does.
            if (!(err instanceof SummaryRejectedError)) throw err;
            sessionMissReason = err.message;
          }
        }
      }
      const fallbackConfig = { ...config, llm: { ...config.llm, provider: config.llm.fallbackProvider ?? "auto" as const } };
      const fallbackProvider = resolveEffectiveProvider(fallbackConfig, ctx.client);
      const fallback = await createSummarizer(fallbackProvider, fallbackConfig);
      if (!fallback) throw new Error("Session summarizer unavailable and fallback disabled");
      ctx.onFallback?.({ reason: sessionMissReason, toProvider: fallbackProvider });
      return fallback(text, aggressive, ctx);
    });
  }
  // No model passed on purpose: config.llm.model is shared across providers, so
  // a model pinned for codex/openai must not leak into the claude CLI.
  if (provider === "claude-process") return withConfiguredLanguage(createClaudeProcessSummarizer());
  if (provider === "codex-process") {
    return withConfiguredLanguage(createCodexProcessSummarizer({ model: config.llm.model }));
  }
  if (provider === "copilot-process") {
    return withConfiguredLanguage(createCopilotProcessSummarizer({ model: config.llm.model }));
  }
  if (provider === "openai") {
    const { createOpenAISummarizer } = await import("../llm/openai.js");
    return withConfiguredLanguage(createOpenAISummarizer({
      model: config.llm.model,
      baseURL: config.llm.baseURL,
      apiKey: config.llm.apiKey,
      reasoning: config.llm.reasoning,
    }));
  }
  // anthropic
  const { createAnthropicSummarizer } = await import("../llm/anthropic.js");
  return withConfiguredLanguage(createAnthropicSummarizer({
    model: config.llm.model,
    apiKey: config.llm.apiKey!,
  }));
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
