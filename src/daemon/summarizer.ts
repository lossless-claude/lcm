import { SummarizeJobStore } from "./summarize-jobs.js";
import { buildSummaryPrompt } from "../llm/prompt.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT, resolveTargetTokens, resolveMaxOutputTokens } from "../summarize.js";
import type { DaemonConfig } from "./config.js";
import { unavailableEndpoints, type EndpointConfig, type ProcessEndpointType } from "./provider-config.js";
import type { DaemonLog } from "./log.js";
import type { LcmPaths } from "../lcm-paths.js";
import { projectAuthorLanguage } from "../search/pivot-language.js";
import { parseLanguageTag } from "../search/language.js";
import { createClaudeProcessSummarizer } from "../llm/claude-process.js";
import { createCodexProcessSummarizer } from "../llm/codex-process.js";
import { createCopilotProcessSummarizer } from "../llm/copilot-process.js";
import { createOmpProcessSummarizer } from "../llm/omp-process.js";
import { createMockSummarizer } from "../llm/mock-summarizer.js";
import type { LcmSummarizeFn } from "../llm/types.js";
import { acceptSummaryText } from "../llm/summary-rejection.js";
import { createProviderChain, SessionJobUnclaimedError, SessionUnavailableError, SummarizerUnavailableError, type ProviderLink, type ProviderLinkKind } from "../llm/provider-chain.js";
import type { SessionClient } from "../session-client.js";

/** The client a /compact call came from; copilot never calls, but its summarizer can be pinned by name. */
export type CompactClient = SessionClient | "copilot";
/**
 * What summarizes first once `auto` is resolved: a provider type, `session` or
 * `disabled`, or with `llm.providers`, an endpoint name.
 */
export type EffectiveProvider = string;

type ConcreteType = EndpointConfig["type"];
const PROCESS_TYPES: ReadonlySet<string> = new Set<ProcessEndpointType>(["claude-process", "codex-process", "copilot-process", "omp-process"]);
const KNOWN_TYPES: ReadonlySet<string> = new Set([...PROCESS_TYPES, "openai", "anthropic"]);

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

function autoProvider(client?: CompactClient): ProcessEndpointType {
  if (client === "codex") return "codex-process";
  if (client === "copilot") return "copilot-process";
  if (client === "omp") return "omp-process";
  return "claude-process";
}

export function resolveEffectiveProvider(config: DaemonConfig, client?: CompactClient): EffectiveProvider {
  return config.llm.provider === "auto" ? autoProvider(client) : config.llm.provider;
}

/**
 * The live session summarizes through its own client. Every way it can fail to
 * answer is a `SessionUnavailableError`, and a rejected answer a `SummaryRejectedError`:
 * the chain hands both to the next link.
 */
function createSessionSummarizer(jobs?: Pick<SummarizeJobStore, "enqueue">, pool = false): LcmSummarizeFn {
  return async (text, aggressive, ctx = {}) => {
    if (!jobs || !ctx.sessionId) throw new SessionUnavailableError("no live session job queue");
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
      inputTokens: Math.ceil(text.length / 4), mode: aggressive ? "aggressive" : "normal",
      isCondensed: ctx.isCondensed ?? false, condensedTargetTokens: 2000,
    });
    const system = ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT;
    const prompt = buildSummaryPrompt(text, aggressive, ctx);
    const answer = await jobs.enqueue({
      session_id: ctx.sessionId, kind: ctx.isCondensed ? "condensed" : "leaf",
      depth: ctx.depth ?? (ctx.isCondensed ? 1 : 0), system, prompt, targetTokens,
      maxTokens: pool && ctx.maxOutputTokens !== undefined ? ctx.maxOutputTokens : resolveMaxOutputTokens(targetTokens),
      ...(pool ? { pool: true as const, workClass: ctx.workClass ?? "live" } : {}),
    });
    for (const attempt of answer.usageAttempts ?? []) {
      ctx.onUsage?.({ provider: attempt.providerId, model: attempt.providerId.split(":")[1],
        inputTokens: attempt.usage.input_tokens, outputTokens: attempt.usage.output_tokens,
        tokensUsed: attempt.usage.input_tokens + attempt.usage.output_tokens,
        estimated: attempt.usage.estimated, failed: attempt.failed ?? true });
    }
    if (pool && ctx.workClass === "timeline" && answer.error === "job unclaimed") throw new SessionJobUnclaimedError();
    if (answer.error) throw new SessionUnavailableError(String(answer.error));
    const summary = answer.text ?? "";
    const inputTokens = answer.usage?.input_tokens ?? Math.ceil((system.length + prompt.length) / 4);
    const outputTokens = answer.usage?.output_tokens ?? Math.ceil(summary.length / 4);
    const provider = answer.providerId ?? (pool ? "session-pool:haiku" : ctx.isCondensed ? "session:fork" : "session:haiku");
    // Reported before the answer is judged: a rejected answer was still charged.
    ctx.onUsage?.({ provider, model: provider.split(":")[1], inputTokens, outputTokens,
      tokensUsed: inputTokens + outputTokens, estimated: answer.usage?.estimated ?? true });
    return acceptSummaryText(summary, provider).trim();
  };
}

/** `label` names a declared endpoint in usage and rejections; without it the adapter uses its type. */
async function createEndpointSummarizer(endpoint: EndpointConfig, label?: string): Promise<LcmSummarizeFn> {
  switch (endpoint.type) {
    case "claude-process":
      return createClaudeProcessSummarizer(endpoint.model ? { model: endpoint.model } : {});
    case "codex-process":
      return createCodexProcessSummarizer({ model: endpoint.model });
    case "copilot-process":
      return createCopilotProcessSummarizer({ model: endpoint.model });
    case "omp-process":
      return createOmpProcessSummarizer({ model: endpoint.model });
    case "openai": {
      const { createOpenAISummarizer } = await import("../llm/openai.js");
      return createOpenAISummarizer({ model: endpoint.model, baseURL: endpoint.baseURL || undefined, apiKey: endpoint.apiKey, body: endpoint.body, label, timeoutMs: endpoint.timeoutMs, maxConcurrent: endpoint.maxConcurrent });
    }
    case "anthropic": {
      const { createAnthropicSummarizer } = await import("../llm/anthropic.js");
      return createAnthropicSummarizer({ model: endpoint.model, apiKey: endpoint.apiKey ?? "", baseURL: endpoint.baseURL, body: endpoint.body, label, timeoutMs: endpoint.timeoutMs, maxConcurrent: endpoint.maxConcurrent });
    }
  }
}

/** The one endpoint the flat `llm.*` fields describe, for a given provider type. */
function flatEndpoint(type: ConcreteType, llm: DaemonConfig["llm"]): EndpointConfig {
  // No model for the claude CLI on purpose: the flat llm.model is shared across
  // providers, so a model pinned for codex/openai must not leak into it.
  if (type === "claude-process") return { type };
  if (type === "codex-process" || type === "copilot-process" || type === "omp-process") return { type, model: llm.model };
  if (type === "anthropic") return { type, model: llm.model, apiKey: llm.apiKey };
  return { type, model: llm.model, baseURL: llm.baseURL, apiKey: llm.apiKey,
    ...(llm.reasoning !== undefined ? { body: { reasoning: llm.reasoning } } : {}) };
}

function kindOf(type: ConcreteType): ProviderLinkKind {
  return PROCESS_TYPES.has(type) ? "process" : "http";
}

/** Builds each link's adapter on first use, and again after a failed build. */
class LinkFactory {
  private readonly adapters = new Map<string, Promise<LcmSummarizeFn>>();
  private readonly session: LcmSummarizeFn;
  private readonly pool: LcmSummarizeFn;

  constructor(private readonly config: DaemonConfig, jobs?: Pick<SummarizeJobStore, "enqueue">) {
    this.session = createSessionSummarizer(jobs);
    this.pool = createSessionSummarizer(jobs, true);
  }

  link(name: string): ProviderLink {
    if (name === "session" || name === "session-pool") {
      return () => ({ name, kind: "session", summarizer: async () => name === "session-pool" ? this.pool : this.session });
    }
    // Resolved per call, from the client that asked, as `auto` is everywhere else.
    if (name === "auto") return (ctx) => this.link(autoProvider(ctx.client))(ctx);
    const endpoint = this.config.llm.providers && Object.hasOwn(this.config.llm.providers, name)
      ? this.config.llm.providers[name]
      : undefined;
    // A named endpoint reports usage under its own name; a provider type under its adapter's label.
    if (endpoint) return this.endpointLink(name, endpoint, name);
    if (this.config.llm.providers && !PROCESS_TYPES.has(name)) throw new Error(`[lcm] No summarizer endpoint named "${name}"`);
    if (!KNOWN_TYPES.has(name)) throw new Error(`[lcm] Unknown summarizer provider "${name}"`);
    return this.endpointLink(name, flatEndpoint(name as ConcreteType, this.config.llm));
  }

  private endpointLink(name: string, endpoint: EndpointConfig, usageLabel?: string): ProviderLink {
    const summarizer = () => this.adapter(name, endpoint, usageLabel);
    const model = endpoint.model || undefined;
    return () => ({ name, kind: kindOf(endpoint.type), usageLabel, model, summarizer });
  }

  private adapter(name: string, endpoint: EndpointConfig, label?: string): Promise<LcmSummarizeFn> {
    let adapter = this.adapters.get(name);
    if (!adapter) {
      adapter = createEndpointSummarizer(endpoint, label);
      // A client library installed after a failed load is picked up on the next call.
      adapter.catch(() => this.adapters.delete(name));
      this.adapters.set(name, adapter);
    }
    return adapter;
  }
}

function missingEnvOf(config: DaemonConfig, name: string): string[] | undefined {
  const endpoint = config.llm.providers && Object.hasOwn(config.llm.providers, name) ? config.llm.providers[name] : undefined;
  return endpoint && "missingEnv" in endpoint ? endpoint.missingEnv : undefined;
}

/** `provider` then `llm.fallback`, without the endpoints whose variables were unset at load. */
function namedChain(provider: EffectiveProvider, config: DaemonConfig): string[] {
  return [provider, ...(config.llm.fallback ?? [])].filter((name) => !missingEnvOf(config, name));
}

/**
 * The links `provider` summarizes through, in order. With `llm.providers`, the
 * endpoints in `llm.fallback` follow it and nothing else does. With the flat form,
 * only the session provider has a fallback: `llm.fallbackProvider`, `auto` if unset.
 */
function chainOf(provider: EffectiveProvider, config: DaemonConfig, links: LinkFactory): ProviderLink[] {
  if (config.llm.providers) return namedChain(provider, config).map((name) => links.link(name));
  if (provider !== "session" && provider !== "session-pool") return [links.link(provider)];
  const fallback = config.llm.fallbackProvider ?? "auto";
  return fallback === "disabled" ? [links.link(provider)] : [links.link(provider), links.link(fallback)];
}

export async function createSummarizer(
  provider: EffectiveProvider,
  config: DaemonConfig,
  jobs?: Pick<SummarizeJobStore, "enqueue">,
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
  const links = chainOf(provider, config, new LinkFactory(config, jobs));
  if (links.length === 0) {
    // Surfaced when a summary is asked for, not at load: the rest of the daemon still runs.
    const unavailable = unavailableEndpoints(config.llm);
    return async () => { throw new SummarizerUnavailableError(unavailable); };
  }
  // The first link is built now, so a missing client library fails before any work;
  // a fallback's is built only when the chain reaches it.
  await links[0]({}).summarizer();
  return withConfiguredLanguage(createProviderChain(links));
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

/** One `summarizer.endpoint_unavailable` warning per declared endpoint left out for an unset variable. */
export function logUnavailableEndpoints(log: Pick<DaemonLog, "write">, llm: DaemonConfig["llm"]): void {
  for (const { name, missingEnv } of unavailableEndpoints(llm)) {
    log.write("warn", "summarizer.endpoint_unavailable", { endpoint: name, missing_env: missingEnv });
  }
}

/**
 * The link a summary is asked of first, and the model it is configured with, taken
 * together so a label never pairs one link's name with another's model. With
 * `llm.providers` it is the primary, or the fallback standing in for a primary left out
 * for an unset variable; in the flat form, `provider` and `llm.model`. The model is
 * undefined when that link names none (the session, a process provider on its default).
 */
export function firstRunnableSummarizer(
  config: DaemonConfig, provider: EffectiveProvider = config.llm.provider,
): { provider: string; model?: string } {
  if (!config.llm.providers) return { provider, ...(config.llm.model ? { model: config.llm.model } : {}) };
  const first = namedChain(provider, config)[0] ?? provider;
  const model = Object.hasOwn(config.llm.providers, first) ? config.llm.providers[first].model : undefined;
  return { provider: first, ...(model ? { model } : {}) };
}

/** The model of `firstRunnableSummarizer`: what the replay ledger records before any answer. */
export function configuredSummaryModel(config: DaemonConfig, provider: EffectiveProvider = config.llm.provider): string | undefined {
  return firstRunnableSummarizer(config, provider).model;
}
