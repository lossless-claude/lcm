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
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[]; dedupBm25Threshold: number; dedupCandidateLimit: number };
  };
  restoration: { recentSummaries: number; promptSearchMinScore: number; promptSearchMaxResults: number; promptSnippetLength: number; recencyHalfLifeHours: number; crossSessionAffinity: number };
  llm: { provider: "auto" | "claude-process" | "codex-process" | "anthropic" | "openai" | "disabled"; model: string; apiKey?: string; baseURL: string };
  summarizer: { mock: boolean };
  security: SecurityConfig;
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
    },
  },
  restoration: { recentSummaries: 3, promptSearchMinScore: 2, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.85 },
  llm: { provider: "auto", model: "", apiKey: "", baseURL: "" },
  summarizer: { mock: false },
  security: {
    sensitivePatterns: [],
  },
};

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== "object") return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      result[key] = (typeof source[key] === "object" && !Array.isArray(source[key]) && typeof target[key] === "object")
        ? deepMerge(target[key], source[key]) : source[key];
    }
  }
  return result;
}

export function loadDaemonConfig(configPath: string, overrides?: any, env?: Record<string, string | undefined>): DaemonConfig {
  const e = env ?? process.env;
  let fileConfig: any = {};
  try { fileConfig = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  const merged = deepMerge(structuredClone(DEFAULTS), deepMerge(fileConfig, overrides));
  // Migrate legacy provider names from v0.3.0
  if (merged.llm.provider === "claude-cli") merged.llm.provider = "claude-process";
  // Migrate legacy mergeMaxEntries (renamed to dedupCandidateLimit)
  if (merged.compaction.promotionThresholds.mergeMaxEntries !== undefined && merged.compaction.promotionThresholds.dedupCandidateLimit === undefined) {
    merged.compaction.promotionThresholds.dedupCandidateLimit = merged.compaction.promotionThresholds.mergeMaxEntries;
  }
  delete merged.compaction.promotionThresholds.mergeMaxEntries;
  delete merged.compaction.promotionThresholds.confidenceDecayRate;
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
    merged.llm.provider = e.LCM_SUMMARY_PROVIDER;
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
