// The knobs a user sets from the environment, resolved once per process.
//
// Every field here has a consumer: `compactEngineConfig` builds the daemon's
// compaction engine from it, and the hook dispatcher reads `enabled`. The
// defaults are the engine's own, so an environment that sets nothing gets the
// same engine as before these knobs existed. The daemon reads the environment
// when it starts; after changing a value, `lcm daemon restart`.

export type LcmConfig = {
  /** `LCM_ENABLED=false` makes every hook exit without doing anything. */
  enabled: boolean;
  /** Fraction of the token budget at which compaction triggers. */
  contextThreshold: number;
  /** Most recent raw messages that are never compacted. */
  freshTailCount: number;
  /** Minimum raw messages outside the fresh tail before a leaf pass runs. */
  leafMinFanout: number;
  /** Same-depth summaries that accumulate before they are condensed. */
  condensedMinFanout: number;
  /** Relaxed minimum fanout for hard-trigger sweeps. */
  condensedMinFanoutHard: number;
  /** Condensation depth after each leaf pass; 0 = leaves only, -1 = unlimited. */
  incrementalMaxDepth: number;
  /** Source tokens per leaf compaction chunk. */
  leafChunkTokens: number;
  /** Target size of a condensed summary, in tokens. */
  condensedTargetTokens: number;
};

export const LCM_CONFIG_DEFAULTS: Readonly<Omit<LcmConfig, "enabled">> = {
  contextThreshold: 0.75,
  freshTailCount: 8,
  leafMinFanout: 3,
  condensedMinFanout: 2,
  condensedMinFanoutHard: 1,
  incrementalMaxDepth: 0,
  leafChunkTokens: 20000,
  condensedTargetTokens: 900,
};

/** A finite number from the variable, or the default when unset or unparsable. */
function numberFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveLcmConfig(env: NodeJS.ProcessEnv = process.env): LcmConfig {
  const defaults = LCM_CONFIG_DEFAULTS;
  return {
    enabled: env.LCM_ENABLED !== "false",
    contextThreshold: numberFrom(env, "LCM_CONTEXT_THRESHOLD", defaults.contextThreshold),
    freshTailCount: numberFrom(env, "LCM_FRESH_TAIL_COUNT", defaults.freshTailCount),
    leafMinFanout: numberFrom(env, "LCM_LEAF_MIN_FANOUT", defaults.leafMinFanout),
    condensedMinFanout: numberFrom(env, "LCM_CONDENSED_MIN_FANOUT", defaults.condensedMinFanout),
    condensedMinFanoutHard: numberFrom(env, "LCM_CONDENSED_MIN_FANOUT_HARD", defaults.condensedMinFanoutHard),
    incrementalMaxDepth: numberFrom(env, "LCM_INCREMENTAL_MAX_DEPTH", defaults.incrementalMaxDepth),
    leafChunkTokens: numberFrom(env, "LCM_LEAF_CHUNK_TOKENS", defaults.leafChunkTokens),
    condensedTargetTokens: numberFrom(env, "LCM_CONDENSED_TARGET_TOKENS", defaults.condensedTargetTokens),
  };
}
