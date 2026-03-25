import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecurityConfig {
  /** User-defined global regex patterns (plain strings, no /.../ delimiters). */
  sensitivePatterns: string[];
}

export type DaemonConfig = {
  version: number;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number; idleTimeoutMs: number };
  compaction: {
    leafTokens: number; maxDepth: number; autoCompactMinTokens: number;
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[]; dedupBm25Threshold: number; dedupCandidateLimit: number; eventConfidence?: { decision?: number; plan?: number; errorFix?: number; batch?: number; pattern?: number }; reinforcementBoost?: number; maxConfidence?: number; insightsMaxAgeDays?: number };
  };
  restoration: { recentSummaries: number; promptSearchMinScore: number; promptSearchMaxResults: number; promptSnippetLength: number; recencyHalfLifeHours: number; crossSessionAffinity: number };
  llm: { provider: "auto" | "claude-process" | "codex-process" | "anthropic" | "openai" | "disabled"; model: string; apiKey?: string; baseURL: string };
  summarizer: { mock: boolean };
  security: SecurityConfig;
  hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
  daemon: { port: 3737, socketPath: join(homedir(), ".lossless-claude", "daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
  compaction: {
    leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
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
  restoration: { recentSummaries: 3, promptSearchMinScore: 2, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.85 },
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
  const VALID_PROVIDERS = new Set(["auto", "claude-process", "codex-process", "anthropic", "openai", "disabled"]);
  if (e.LCM_SUMMARY_PROVIDER) {
    if (!VALID_PROVIDERS.has(e.LCM_SUMMARY_PROVIDER)) {
      throw new Error(
        `[lcm] Invalid LCM_SUMMARY_PROVIDER="${e.LCM_SUMMARY_PROVIDER}". ` +
        `Valid values: ${[...VALID_PROVIDERS].join(", ")}`
      );
    }
    merged.llm.provider = e.LCM_SUMMARY_PROVIDER as DaemonConfig["llm"]["provider"];
  }

  // Anthropic API key fallback from env
  if (!merged.llm.apiKey && merged.llm.provider === "anthropic" && e.ANTHROPIC_API_KEY) {
    merged.llm.apiKey = e.ANTHROPIC_API_KEY;
  }

  // Validate: anthropic provider requires an API key
  if (merged.llm.provider === "anthropic" && !merged.llm.apiKey) {
    throw new Error(
      "[lcm] LCM_SUMMARY_API_KEY is required when using the Anthropic provider. " +
      "Set it in your environment or switch to 'auto', 'claude-process', or another provider."
    );
  }

  return merged;
}
