import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeNamedEndpoints, type EndpointConfig } from "./provider-config.js";

export interface SecurityConfig {
  /** User-defined global regex patterns (plain strings, no /.../ delimiters). */
  sensitivePatterns: string[];
  /**
   * Emit a stderr warning when sensitive data is filtered from session history.
   * Shows the pattern category (e.g. "gitleaks", "built_in"), not the actual value.
   * Defaults to true.
   */
  notify_on_filter?: boolean;
}

export type SummaryProvider = "auto" | "claude-process" | "codex-process" | "copilot-process" | "omp-process" | "anthropic" | "openai" | "disabled" | "session" | "session-pool";

export type DaemonConfig = {
  version: number;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number; idleTimeoutMs: number };
  compaction: {
    /** Below this many tokens `lcm compact` leaves a conversation alone; 0 compacts every one. */
    autoCompactMinTokens: number;
    /** Max conversations of the same project a session start requests compaction for; a larger backlog drains over several starts. */
    autoCompactSessionStartMax: number;
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[]; dedupBm25Threshold: number; dedupCandidateLimit: number; eventConfidence?: { decision?: number; plan?: number; errorFix?: number; batch?: number; pattern?: number }; reinforcementBoost?: number; maxConfidence?: number; insightsMaxAgeDays?: number };
  };
  search: {
    /**
     * Union episodic history across every checkout of one repository.
     *
     * Off until the bench says otherwise: a union multiplies the candidate pool
     * by the number of checkouts, and history is where the noise is. Promoted
     * memory is unioned unconditionally and is not covered by this switch.
     */
    unionHistoryAcrossGroup: boolean;
    /**
     * The language a caller translates its query into when the project's author
     * writes in another one — the target of `lcm_search`'s `pivotQuery`, not a
     * detected property of the corpus.
     */
    pivotLanguage: string;
  };
  restoration: {
    recentSummaries: number;
    promptSearchMinScore: number;
    promptSearchMaxResults: number;
    promptSnippetLength: number;
    maxInjectedMemoryBytes: number;
    reservedForLearningInstruction: number;
    maxInjectedMemoryItems: number;
    dedupMinPrefix: number;
    recencyHalfLifeHours: number;
    crossSessionAffinity: number;
    recallUsageBoost: number;
    recallUsageSmoothing: number;
    surfacingCooldownWindow: number;
    resurfaceMargin: number;
    unusedSurfacingPenalty: number;
    staleAfterDays: number;
    staleSurfacingWithoutUseLimit: number;
    restoreMaxPromotedAgeDays: number;
    stalePenalty: number;
    allowStaleOnStrongMatch: boolean;
  };
  llm: {
    /** A provider type or `session`/`auto`/`disabled`; with `providers`, an endpoint name. */
    provider: SummaryProvider | (string & {});
    /** Flat form only: the provider type the session provider falls back to. */
    fallbackProvider?: Exclude<SummaryProvider, "session" | "session-pool">;
    poolCompletionMs?: number;
    model: string; apiKey?: string; baseURL: string; reasoning?: Record<string, unknown>;
    /** Named endpoints; when present, the flat connection fields above must be unset. */
    providers?: Record<string, EndpointConfig>;
    /** Endpoint names tried in order after `provider` fails. */
    fallback?: string[];
  };
  summarizer: { mock: boolean; language?: string };
  timeline: { generationEnabled: boolean };
  commits: { enabled: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
  promotion: {
    /** Uses at or above this count make a memory a promotion candidate in `lcm stats`. */
    enforcementThreshold: number;
  };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
  // Filled in by loadDaemonConfig from configPath's own directory — this field is otherwise
  // unused (the daemon serves over the TCP port, not a socket), so it never needs the
  // storage root directly.
  daemon: { port: 3737, socketPath: "", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
  compaction: {
    autoCompactMinTokens: 10000,
    autoCompactSessionStartMax: 2,
    promotionThresholds: {
      minDepth: 2, compressionRatio: 0.3,
      keywords: { decision: ["decided", "agreed", "will use", "going with", "chosen"], fix: ["fixed", "root cause", "workaround", "resolved"] },
      architecturePatterns: ["src/[\\w/]+\\.ts", "[A-Z][a-zA-Z]+(Engine|Store|Service|Manager|Handler|Client)", "interface [A-Z]", "class [A-Z]"],
      dedupBm25Threshold: 15,
      dedupCandidateLimit: 100,
      eventConfidence: {
        decision: 0.5,
        plan: 0.7,
        errorFix: 0.4,
        batch: 0.3,
        pattern: 0.2,
      },
      reinforcementBoost: 0.3,
      maxConfidence: 1.0,
      insightsMaxAgeDays: 90,
    },
  },
  search: { unionHistoryAcrossGroup: false, pivotLanguage: "en" },
  restoration: {
    recentSummaries: 3,
    promptSearchMinScore: 2,
    promptSearchMaxResults: 3,
    promptSnippetLength: 200,
    maxInjectedMemoryBytes: 2048,
    reservedForLearningInstruction: 1024,
    maxInjectedMemoryItems: 3,
    dedupMinPrefix: 64,
    recencyHalfLifeHours: 24,
    crossSessionAffinity: 0.85,
    recallUsageBoost: 0.75,
    recallUsageSmoothing: 1,
    surfacingCooldownWindow: 2,
    resurfaceMargin: 0.75,
    unusedSurfacingPenalty: 0.15,
    staleAfterDays: 90,
    staleSurfacingWithoutUseLimit: 5,
    restoreMaxPromotedAgeDays: 180,
    stalePenalty: 0.5,
    allowStaleOnStrongMatch: true,
  },
  llm: { provider: "auto", model: "", apiKey: "", baseURL: "", poolCompletionMs: 180_000 },
  summarizer: { mock: false },
  timeline: { generationEnabled: false },
  commits: { enabled: true },
  security: {
    sensitivePatterns: [],
  },
  hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
  promotion: { enforcementThreshold: 3 },
};

const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  if (!source || typeof source !== "object") return target;
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (DENIED_KEYS.has(key)) continue;
    if (source[key] !== undefined) {
      result[key] = (
        typeof source[key] === "object" &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      )
        ? deepMerge(result[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
        : source[key];
    }
  }
  return result;
}

export function loadDaemonConfig(configPath: string, overrides?: any, env?: Record<string, string | undefined>): DaemonConfig {
  const e = env ?? process.env;
  let fileConfig: any = {};
  try { fileConfig = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  // Always merge untrusted sources (fileConfig, overrides) into a trusted target so that
  // DENIED_KEYS filtering applies before any untrusted key reaches the result object.
  // Precedence: DEFAULTS < fileConfig < overrides.
  const withFile = deepMerge(structuredClone(DEFAULTS) as Record<string, unknown>, fileConfig);
  const merged = deepMerge(withFile, overrides ?? {}) as DaemonConfig;
  if (typeof merged.timeline.generationEnabled !== "boolean") throw new Error("timeline.generationEnabled must be a boolean");
  if (typeof merged.commits.enabled !== "boolean") throw new Error("commits.enabled must be a boolean");
  if (!merged.daemon.socketPath) merged.daemon.socketPath = join(dirname(configPath), "daemon.sock");
  if (e.LCM_POOL_COMPLETION_MS !== undefined) merged.llm.poolCompletionMs = Number(e.LCM_POOL_COMPLETION_MS);
  const completionMs = merged.llm.poolCompletionMs;
  if (!Number.isSafeInteger(completionMs) || completionMs! <= 0 || completionMs! > 2_147_483_647) {
    throw new Error("Pool completion deadline must be a positive integer no greater than 2147483647 ms");
  }
  // Migrate legacy provider names from v0.3.0
  if ((merged.llm.provider as string) === "claude-cli") merged.llm.provider = "claude-process";
  // Migrate legacy mergeMaxEntries (renamed to dedupCandidateLimit)
  const thresholds = merged.compaction.promotionThresholds as Record<string, unknown>;
  if (thresholds["mergeMaxEntries"] !== undefined && thresholds["dedupCandidateLimit"] === undefined) {
    thresholds["dedupCandidateLimit"] = thresholds["mergeMaxEntries"];
  }
  delete thresholds["mergeMaxEntries"];
  delete thresholds["confidenceDecayRate"];
  normalizeNamedEndpoints(merged.llm, e);
  const namedEndpoints = merged.llm.providers !== undefined;
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => e[k] ?? "");

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  const VALID_PROVIDERS = new Set(["auto", "claude-process", "codex-process", "copilot-process", "omp-process", "anthropic", "openai", "disabled", "session", "session-pool"]);
  if (e.LCM_SUMMARY_PROVIDER && !namedEndpoints) {
    if (!VALID_PROVIDERS.has(e.LCM_SUMMARY_PROVIDER)) {
      throw new Error(
        `[lcm] Invalid LCM_SUMMARY_PROVIDER="${e.LCM_SUMMARY_PROVIDER}". ` +
        `Valid values: ${[...VALID_PROVIDERS].join(", ")}`
      );
    }
    merged.llm.provider = e.LCM_SUMMARY_PROVIDER as DaemonConfig["llm"]["provider"];
  }
  // A typo here would otherwise surface only at the first summary, as an opaque error.
  if (!namedEndpoints && !VALID_PROVIDERS.has(merged.llm.provider)) {
    throw new Error(
      `[lcm] Unknown summarizer provider "${merged.llm.provider}" in llm.provider. ` +
      `Valid values: ${[...VALID_PROVIDERS].join(", ")}, or an endpoint named in llm.providers`
    );
  }
  const fallbackProvider: unknown = merged.llm.fallbackProvider;
  if (fallbackProvider !== undefined && (
    typeof fallbackProvider !== "string" || (fallbackProvider === "session" || fallbackProvider === "session-pool") || !VALID_PROVIDERS.has(fallbackProvider)
  )) {
    throw new Error("[lcm] Invalid llm.fallbackProvider. Expected a summary provider other than 'session' or 'session-pool'.");
  }

  // Migrate old config names to new names for backward compatibility
  const oldNameMap: Record<string, string> = {
    promptHintsByteBudget: "maxInjectedMemoryBytes",
    promptHintsReservedForLearningInstruction: "reservedForLearningInstruction",
    promptHintsMaxEmitted: "maxInjectedMemoryItems",
    promptHintsDedupMinPrefix: "dedupMinPrefix",
  };
  for (const [oldName, newName] of Object.entries(oldNameMap)) {
    const restoration = merged.restoration as Record<string, unknown>;
    if (restoration[oldName] !== undefined) {
      // Only migrate if the new name was not explicitly set by the user
      if (restoration[newName] === (DEFAULTS.restoration as Record<string, unknown>)[newName]) {
        restoration[newName] = restoration[oldName];
      }
      delete restoration[oldName];
    }
  }

  // Session fallbacks use the same credentials as directly selected providers.
  // Named endpoints resolved their own keys above.
  const usesAnthropic = !namedEndpoints && (merged.llm.provider === "anthropic" ||
    (["session", "session-pool"].includes(merged.llm.provider) && merged.llm.fallbackProvider === "anthropic"));
  if (!merged.llm.apiKey && usesAnthropic && e.ANTHROPIC_API_KEY) {
    merged.llm.apiKey = e.ANTHROPIC_API_KEY;
  }

  // Validate: `reasoning` is spread verbatim into the provider request, so a
  // non-object here fails only at request time as an opaque provider HTTP error.
  // The shape beyond "is an object" stays free-form: it differs per provider.
  const reasoning: unknown = merged.llm.reasoning;
  if (reasoning !== undefined && (typeof reasoning !== "object" || reasoning === null || Array.isArray(reasoning))) {
    throw new Error(
      `[lcm] llm.reasoning must be a JSON object (got ${Array.isArray(reasoning) ? "array" : reasoning === null ? "null" : typeof reasoning}). ` +
      `Example: { "reasoning": { "effort": "minimal" } }`
    );
  }

  // Validate: anthropic provider requires an API key
  if (usesAnthropic && !merged.llm.apiKey) {
    throw new Error(
      "[lcm] The Anthropic provider needs an API key: set `llm.apiKey` in ~/.lossless-claude/config.json " +
      "or export ANTHROPIC_API_KEY, or switch to 'auto', 'claude-process', or another provider."
    );
  }

  return merged;
}
