import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lcmPath } from "../lcm-home.js";

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

export type SummaryProvider = "auto" | "claude-process" | "codex-process" | "copilot-process" | "anthropic" | "openai" | "disabled" | "session";

export type DaemonConfig = {
  version: number;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number; idleTimeoutMs: number };
  compaction: {
    /** Below this many tokens `lcm compact` leaves a conversation alone; 0 compacts every one. */
    autoCompactMinTokens: number;
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
  llm: { provider: SummaryProvider; fallbackProvider?: Exclude<SummaryProvider, "session">; model: string; apiKey?: string; baseURL: string; reasoning?: Record<string, unknown> };
  summarizer: { mock: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
  daemon: { port: 3737, socketPath: lcmPath("daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
  compaction: {
    autoCompactMinTokens: 10000,
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
  search: { unionHistoryAcrossGroup: false },
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
  llm: { provider: "auto", model: "", apiKey: "", baseURL: "" },
  summarizer: { mock: false },
  security: {
    sensitivePatterns: [],
  },
  hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
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
  // Migrate legacy provider names from v0.3.0
  if ((merged.llm.provider as string) === "claude-cli") merged.llm.provider = "claude-process";
  // Migrate legacy mergeMaxEntries (renamed to dedupCandidateLimit)
  const thresholds = merged.compaction.promotionThresholds as Record<string, unknown>;
  if (thresholds["mergeMaxEntries"] !== undefined && thresholds["dedupCandidateLimit"] === undefined) {
    thresholds["dedupCandidateLimit"] = thresholds["mergeMaxEntries"];
  }
  delete thresholds["mergeMaxEntries"];
  delete thresholds["confidenceDecayRate"];
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => e[k] ?? "");

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  const VALID_PROVIDERS = new Set(["auto", "claude-process", "codex-process", "copilot-process", "anthropic", "openai", "disabled", "session"]);
  if (e.LCM_SUMMARY_PROVIDER) {
    if (!VALID_PROVIDERS.has(e.LCM_SUMMARY_PROVIDER)) {
      throw new Error(
        `[lcm] Invalid LCM_SUMMARY_PROVIDER="${e.LCM_SUMMARY_PROVIDER}". ` +
        `Valid values: ${[...VALID_PROVIDERS].join(", ")}`
      );
    }
    merged.llm.provider = e.LCM_SUMMARY_PROVIDER as DaemonConfig["llm"]["provider"];
  }
  const fallbackProvider: unknown = merged.llm.fallbackProvider;
  if (fallbackProvider !== undefined && (
    typeof fallbackProvider !== "string" || fallbackProvider === "session" || !VALID_PROVIDERS.has(fallbackProvider)
  )) {
    throw new Error("[lcm] Invalid llm.fallbackProvider. Expected a summary provider other than 'session'.");
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
  const usesAnthropic = merged.llm.provider === "anthropic" ||
    (merged.llm.provider === "session" && merged.llm.fallbackProvider === "anthropic");
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
      "[lcm] LCM_SUMMARY_API_KEY is required when using the Anthropic provider. " +
      "Set it in your environment or switch to 'auto', 'claude-process', or another provider."
    );
  }

  return merged;
}
