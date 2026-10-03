import { createHash, randomUUID } from "node:crypto";
import { yieldToEventLoop } from "./daemon/project-queue.js";
import type { ConversationStore, CreateMessagePartInput } from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./store/summary-store.js";
import { extractFileIdsFromContent } from "./large-files.js";
import type { ScrubEngine } from "./scrub.js";
import { LCM_CONFIG_DEFAULTS, resolveLcmConfig } from "./db/config.js";
import { acceptSummaryText, SummaryRejectedError } from "./llm/summary-rejection.js";
import { ProviderChainExhaustedError } from "./llm/provider-chain.js";
import { boundToolSummaryContext, type ToolSummaryContext } from "./tool-summary-context.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompactionResult {
  actionTaken: boolean;
  /** Tokens before compaction */
  tokensBefore: number;
  /** Tokens after compaction */
  tokensAfter: number;
  /** Summary created (if any) */
  createdSummaryId?: string;
  /** All summaries created by this request, in creation order. */
  createdSummaryIds?: string[];
  /** Whether condensation was performed */
  condensed: boolean;
  /** Escalation level used: "normal" | "aggressive" | "fallback" */
  level?: CompactionLevel;
}

export interface CompactionConfig {
  /** Cancel before publishing a summary after an expired request. */
  signal?: AbortSignal;
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 8) */
  freshTailCount: number;
  /** Minimum number of depth-0 summaries needed for condensation. */
  leafMinFanout: number;
  /** Minimum number of depth>=1 summaries needed for condensation. */
  condensedMinFanout: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Target tokens for condensed summaries (default 900) */
  condensedTargetTokens: number;
  /** IANA timezone for timestamps in summaries (default: UTC) */
  timezone?: string;
  /** BCP 47 language tag for generated summaries, when configured or detected. */
  language?: string;
  /** Optional scrubber to redact secrets before sending chunk text to LLM */
  scrubber?: ScrubEngine;
  /**
   * Called when the engine throws away the summarizer's latest answer instead of
   * persisting it: before asking again aggressively, and before the deterministic
   * truncation. Lets a caller attribute the stored summary to the answer it came from.
   */
  onAnswerDiscarded?: () => void;
}

/** Token budget the `/compact` route compacts against. */
export const COMPACT_TOKEN_BUDGET = 200_000;

/**
 * The engine configuration the daemon's `/compact` route runs.
 *
 * Single source of truth: the summarizer eval bench builds its engine from this
 * same function, so the bench cannot silently drift into measuring a different
 * engine than production runs. The scrubber is the one per-caller value; the
 * bench passes none, its corpus having been scrubbed at ingest.
 */
export function compactEngineConfig(opts: {
  scrubber?: ScrubEngine;
  /** Language for generated summaries, when configured or detected. */
  language?: string;
  /** The environment to read `LCM_*` knobs from; the process's own by default. */
  env?: NodeJS.ProcessEnv;
} = {}): CompactionConfig {
  const knobs = resolveLcmConfig(opts.env ?? process.env);
  return {
    contextThreshold: knobs.contextThreshold,
    freshTailCount: knobs.freshTailCount,
    leafMinFanout: knobs.leafMinFanout,
    condensedMinFanout: knobs.condensedMinFanout,
    leafChunkTokens: knobs.leafChunkTokens,
    condensedTargetTokens: knobs.condensedTargetTokens,
    language: opts.language,
    scrubber: opts.scrubber,
  };
}

type CompactionLevel = "normal" | "aggressive" | "fallback";
type CompactionPass = "leaf" | "condensed";
type CompactionSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
  depth?: number;
  language?: string;
  toolContext?: ToolSummaryContext;
};
export type CompactionSummarizeFn = (
  text: string,
  aggressive?: boolean,
  options?: CompactionSummarizeOptions,
) => Promise<string>;
type PassResult = { summaryId: string; level: CompactionLevel; tokenDelta: number };
type EscalationResult = { content: string; level: CompactionLevel; keptAnswers: number };
type EscalationParams = {
  sourceTexts: string[];
  /** Leaf source identities stay aligned with texts when output-cut recovery splits them. */
  sourceMessageIds?: number[];
  summarize: CompactionSummarizeFn;
  options?: CompactionSummarizeOptions;
  /** Halvings already made after output cuts. */
  splitDepth?: number;
};

const LEVEL_ORDER: CompactionLevel[] = ["normal", "aggressive", "fallback"];
/** A joined summary reports the strongest escalation either half needed. */
function highestLevel(a: CompactionLevel, b: CompactionLevel): CompactionLevel {
  return LEVEL_ORDER[Math.max(LEVEL_ORDER.indexOf(a), LEVEL_ORDER.indexOf(b))];
}
type LeafChunkSelection = {
  items: ContextItemRecord[];
};
type CondensedChunkSelection = {
  items: ContextItemRecord[];
  summaryTokens: number;
};
type CondensedPhaseCandidate = {
  targetDepth: number;
  chunk: CondensedChunkSelection;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Estimate token count from character length (~4 chars per token). */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/** An exhausted chain containing a cut can still converge on smaller source chunks. */
function containsOutputCut(error: unknown): boolean {
  if (error instanceof SummaryRejectedError) return error.reason !== "whitespace";
  return error instanceof ProviderChainExhaustedError && error.failures.some(failure => containsOutputCut(failure.error));
}

/** Format a timestamp as `YYYY-MM-DD HH:mm TZ` for prompt source text. */
export function formatTimestamp(value: Date, timezone: string = "UTC"): string {
  try {
    let fmt = timestampFormatters.get(timezone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      timestampFormatters.set(timezone, fmt);
    }
    const parts = Object.fromEntries(
      fmt.formatToParts(value).map((p) => [p.type, p.value]),
    );
    const tzAbbr = timezone === "UTC" ? "UTC" : shortTzAbbr(value, timezone);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tzAbbr}`;
  } catch {
    // Fallback to UTC on invalid timezone
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    const hours = String(value.getUTCHours()).padStart(2, "0");
    const minutes = String(value.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
  }
}

/** Extract short timezone abbreviation (e.g. "PST", "PDT", "EST"). */
function shortTzAbbr(value: Date, timezone: string): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(value)
      .find((p) => p.type === "timeZoneName")?.value;
    return abbr ?? timezone;
  } catch {
    return timezone;
  }
}

/** A summary id; unique even for identical content summarized in the same millisecond. */
function generateSummaryId(content: string): string {
  return (
    "sum_" +
    createHash("sha256")
      .update(content + Date.now().toString() + randomUUID())
      .digest("hex")
      .slice(0, 16)
  );
}

/** Maximum characters for the deterministic fallback truncation (512 tokens * 4 chars). */
const FALLBACK_MAX_CHARS = 512 * 4;
/** Halvings after repeated output cuts: at most 2^3 = 8 pieces per chunk, so the extra calls stay bounded. */
const MAX_CUT_SPLIT_DEPTH = 3;
const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;
const CONDENSED_MIN_INPUT_RATIO = 0.1;
/** Bound synchronous selection and source preparation between event-loop turns. */
const COMPACTION_YIELD_EVERY = 64;
const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function dedupeOrderedIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

// ── CompactionEngine ─────────────────────────────────────────────────────────

export class CompactionEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private config: CompactionConfig,
  ) {}

  // ── compact ──────────────────────────────────────────────────────────────

  /**
   * Run a full compaction sweep for a conversation:
   *
   * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
   * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
   *          remains high enough to be worthwhile.
   */
  async compact(input: {
    conversationId: number;
    tokenBudget: number;
    summarize: CompactionSummarizeFn;
    force?: boolean;
    /** Seed context from a prior session's final summary (used in replay import). */
    previousSummaryContent?: string;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;
    if (this.conversationStore.isWorkerExcluded(conversationId)) {
      return { actionTaken: false, tokensBefore: 0, tokensAfter: 0, condensed: false };
    }

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
    const leafTrigger = await this.evaluateLeafTrigger(conversationId);

    if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const contextItems = await this.summaryStore.getContextItems(conversationId);
    if (contextItems.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    let actionTaken = false;
    let condensed = false;
    let createdSummaryId: string | undefined;
    const createdSummaryIds: string[] = [];
    let level: CompactionLevel | undefined;
    // Seed from caller (cross-session replay) or start fresh
    let previousSummaryContent: string | undefined;
    let previousTokens = tokensBefore;
    let contextTokens = tokensBefore;
    let contextItemCount = contextItems.length;
    const updateTokens = async (pass: PassResult, replacedItemCount: number): Promise<number> => {
      contextTokens += pass.tokenDelta;
      contextItemCount -= replacedItemCount - 1;
      // Capture can append while the model releases the project mutation lease.
      // Read only that suffix after replacement resequences the old context.
      const appended = await this.summaryStore.getContextItems(conversationId, { afterOrdinal: contextItemCount - 1 });
      contextTokens += await this.countStoredContextTokens(appended);
      contextItemCount += appended.length;
      return contextTokens;
    };
    let isFirstLeafPass = true;

    // Phase 1: leaf passes over oldest raw chunks outside the protected tail.
    while (true) {
      await yieldToEventLoop();
      this.config.signal?.throwIfAborted();
      const leafChunk = await this.selectOldestLeafChunk(conversationId);
      if (leafChunk.items.length === 0) {
        break;
      }

      // For first leaf pass: use caller's seed if provided, otherwise resolve from store
      if (isFirstLeafPass) {
        const MAX_PREVIOUS_SUMMARY_LENGTH = 50_000;
        const seedSummary = input.previousSummaryContent ?? (await this.resolvePriorLeafSummaryContext(conversationId, leafChunk.items));
        previousSummaryContent = seedSummary ? seedSummary.slice(0, MAX_PREVIOUS_SUMMARY_LENGTH) : undefined;
        isFirstLeafPass = false;
      }

      const passTokensBefore = contextTokens;
      const leafResult = await this.leafPass(
        conversationId,
        leafChunk.items,
        summarize,
        previousSummaryContent,
      );
      const passTokensAfter = await updateTokens(leafResult, leafChunk.items.length);
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensAfter,
        tokensAfterFinal: passTokensAfter,
        leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
        condenseResult: null,
      });

      actionTaken = true;
      createdSummaryId = leafResult.summaryId;
      createdSummaryIds.push(leafResult.summaryId);
      level = leafResult.level;
      previousSummaryContent = leafResult.content;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    // Phase 2: depth-aware condensed passes, always processing shallowest depth first.
    while (true) {
      await yieldToEventLoop();
      this.config.signal?.throwIfAborted();
      const candidate = await this.selectShallowestCondensationCandidate({
        conversationId,
      });
      if (!candidate) {
        break;
      }

      const passTokensBefore = contextTokens;
      const condenseResult = await this.condensedPass(
        conversationId,
        candidate.chunk.items,
        candidate.targetDepth,
        summarize,
      );
      const passTokensAfter = await updateTokens(condenseResult, candidate.chunk.items.length);
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensBefore,
        tokensAfterFinal: passTokensAfter,
        leafResult: null,
        condenseResult,
      });

      actionTaken = true;
      condensed = true;
      createdSummaryId = condenseResult.summaryId;
      createdSummaryIds.push(condenseResult.summaryId);
      level = condenseResult.level;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    const tokensAfter = contextTokens;

    return {
      actionTaken,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      createdSummaryIds,
      condensed,
      level,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Evaluate whether the raw-message leaf trigger is active.
   *
   * Counts message tokens outside the protected fresh tail and compares against
   * `leafChunkTokens`.
   */
  private async evaluateLeafTrigger(conversationId: number): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    const rawTokensOutsideTail = await this.countRawTokensOutsideFreshTail(conversationId);
    const threshold = this.resolveLeafChunkTokens();
    return {
      shouldCompact: rawTokensOutsideTail >= threshold,
      rawTokensOutsideTail,
      threshold,
    };
  }

  /** Normalize configured leaf chunk size to a safe positive integer. */
  private resolveLeafChunkTokens(): number {
    if (
      typeof this.config.leafChunkTokens === "number" &&
      Number.isFinite(this.config.leafChunkTokens) &&
      this.config.leafChunkTokens > 0
    ) {
      return Math.floor(this.config.leafChunkTokens);
    }
    return DEFAULT_LEAF_CHUNK_TOKENS;
  }

  /** Normalize configured fresh tail count to a safe non-negative integer. */
  private resolveFreshTailCount(): number {
    if (
      typeof this.config.freshTailCount === "number" &&
      Number.isFinite(this.config.freshTailCount) &&
      this.config.freshTailCount > 0
    ) {
      return Math.floor(this.config.freshTailCount);
    }
    return 0;
  }

  /**
   * Compute the ordinal boundary for protected fresh messages.
   *
   * Messages with ordinal >= returned value are preserved as fresh tail.
   */
  private resolveFreshTailOrdinal(contextItems: ContextItemRecord[]): number {
    const freshTailCount = this.resolveFreshTailCount();
    if (freshTailCount <= 0) {
      return Infinity;
    }

    const rawMessageItems = contextItems.filter(
      (item) => item.itemType === "message" && item.messageId != null,
    );
    if (rawMessageItems.length === 0) {
      return Infinity;
    }

    const tailStartIdx = Math.max(0, rawMessageItems.length - freshTailCount);
    return rawMessageItems[tailStartIdx]?.ordinal ?? Infinity;
  }

  /** Resolve message token count with a content-length fallback. */
  private async getMessageTokenCount(messageId: number): Promise<number> {
    const message = await this.conversationStore.getMessageById(messageId);
    if (!message) {
      return 0;
    }
    if (
      typeof message.tokenCount === "number" &&
      Number.isFinite(message.tokenCount) &&
      message.tokenCount > 0
    ) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  private async countStoredContextTokens(items: ContextItemRecord[]): Promise<number> {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      if (i % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      const item = items[i];
      const record = item.itemType === "message" && item.messageId != null
        ? await this.conversationStore.getMessageById(item.messageId)
        : item.summaryId ? await this.summaryStore.getSummary(item.summaryId) : null;
      total += record?.tokenCount ?? 0;
    }
    return total;
  }

  /** Sum raw message tokens outside the protected fresh tail. */
  private async countRawTokensOutsideFreshTail(conversationId: number): Promise<number> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    let rawTokens = 0;

    let processed = 0;
    for (const item of contextItems) {
      if (processed++ % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "message" || item.messageId == null) {
        continue;
      }
      rawTokens += await this.getMessageTokenCount(item.messageId);
    }

    return rawTokens;
  }

  /**
   * Select the oldest contiguous raw-message chunk outside fresh tail.
   *
   * The selected chunk size is capped by `leafChunkTokens`, but we always pick
   * at least one message when any compactable message exists.
   */
  private async selectOldestLeafChunk(conversationId: number): Promise<LeafChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const threshold = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let chunkTokens = 0;
    let started = false;
    let processed = 0;
    for (const item of contextItems) {
      if (processed++ % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }

      if (!started) {
        if (item.itemType !== "message" || item.messageId == null) {
          continue;
        }
        started = true;
      } else if (item.itemType !== "message" || item.messageId == null) {
        break;
      }

      if (item.messageId == null) {
        continue;
      }
      const messageTokens = await this.getMessageTokenCount(item.messageId);
      if (chunk.length > 0 && chunkTokens + messageTokens > threshold) {
        break;
      }

      chunk.push(item);
      chunkTokens += messageTokens;
      if (chunkTokens >= threshold) {
        break;
      }
    }

    return { items: chunk };
  }

  /**
   * Resolve recent summary continuity for a leaf pass.
   *
   * Collects up to two most recent summary context items that precede the
   * compacted raw-message chunk and returns their combined content.
   */
  private async resolvePriorLeafSummaryContext(
    conversationId: number,
    messageItems: ContextItemRecord[],
  ): Promise<string | undefined> {
    if (messageItems.length === 0) {
      return undefined;
    }

    const startOrdinal = Math.min(...messageItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
      .filter(
        (item) =>
          item.ordinal < startOrdinal &&
          item.itemType === "summary" &&
          typeof item.summaryId === "string",
      )
      .slice(-2);

    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      const content = summary?.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }

    return summaryContents.join("\n\n");
  }

  /** Resolve summary token count with content-length fallback. */
  private resolveSummaryTokenCount(summary: SummaryRecord): number {
    if (
      typeof summary.tokenCount === "number" &&
      Number.isFinite(summary.tokenCount) &&
      summary.tokenCount > 0
    ) {
      return summary.tokenCount;
    }
    return estimateTokens(summary.content);
  }

  /** Resolve message token count with content-length fallback. */
  private resolveMessageTokenCount(message: { tokenCount: number; content: string }): number {
    if (
      typeof message.tokenCount === "number" &&
      Number.isFinite(message.tokenCount) &&
      message.tokenCount > 0
    ) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  private resolveLeafMinFanout(): number {
    if (
      typeof this.config.leafMinFanout === "number" &&
      Number.isFinite(this.config.leafMinFanout) &&
      this.config.leafMinFanout > 0
    ) {
      return Math.floor(this.config.leafMinFanout);
    }
    return LCM_CONFIG_DEFAULTS.leafMinFanout;
  }

  private resolveCondensedMinFanout(): number {
    if (
      typeof this.config.condensedMinFanout === "number" &&
      Number.isFinite(this.config.condensedMinFanout) &&
      this.config.condensedMinFanout > 0
    ) {
      return Math.floor(this.config.condensedMinFanout);
    }
    return LCM_CONFIG_DEFAULTS.condensedMinFanout;
  }

  private resolveFanoutForDepth(targetDepth: number): number {
    if (targetDepth === 0) {
      return this.resolveLeafMinFanout();
    }
    return this.resolveCondensedMinFanout();
  }

  /** Minimum condensed input size before we run another condensed pass. */
  private resolveCondensedMinChunkTokens(): number {
    const chunkTarget = this.resolveLeafChunkTokens();
    const ratioFloor = Math.floor(chunkTarget * CONDENSED_MIN_INPUT_RATIO);
    return Math.max(this.config.condensedTargetTokens, ratioFloor);
  }

  /**
   * Find the shallowest depth with an eligible same-depth summary chunk.
   */
  private async selectShallowestCondensationCandidate(params: {
    conversationId: number;
  }): Promise<CondensedPhaseCandidate | null> {
    const { conversationId } = params;
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
    const minChunkTokens = this.resolveCondensedMinChunkTokens();
    const depthLevels = await this.summaryStore.getDistinctDepthsInContext(conversationId, {
      maxOrdinalExclusive: freshTailOrdinal,
    });

    for (const targetDepth of depthLevels) {
      const fanout = this.resolveFanoutForDepth(targetDepth);
      const chunk = await this.selectOldestChunkAtDepth(
        conversationId,
        targetDepth,
        freshTailOrdinal,
      );
      if (chunk.items.length < fanout) {
        continue;
      }
      if (chunk.summaryTokens < minChunkTokens) {
        continue;
      }
      return { targetDepth, chunk };
    }

    return null;
  }

  /**
   * Select the oldest contiguous summary chunk at a specific summary depth.
   *
   * Once selection starts, any non-summary item or depth mismatch terminates
   * the chunk to prevent mixed-depth condensation.
   */
  private async selectOldestChunkAtDepth(
    conversationId: number,
    targetDepth: number,
    freshTailOrdinalOverride?: number,
  ): Promise<CondensedChunkSelection> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const freshTailOrdinal =
      typeof freshTailOrdinalOverride === "number"
        ? freshTailOrdinalOverride
        : this.resolveFreshTailOrdinal(contextItems);
    const chunkTokenBudget = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let summaryTokens = 0;
    let processed = 0;
    for (const item of contextItems) {
      if (processed++ % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "summary" || item.summaryId == null) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }

      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      if (summary.depth !== targetDepth) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      const tokenCount = this.resolveSummaryTokenCount(summary);

      if (chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
        break;
      }

      chunk.push(item);
      summaryTokens += tokenCount;
      if (summaryTokens >= chunkTokenBudget) {
        break;
      }
    }

    return { items: chunk, summaryTokens };
  }

  private async resolvePriorSummaryContextAtDepth(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    targetDepth: number,
  ): Promise<string | undefined> {
    if (summaryItems.length === 0) {
      return undefined;
    }

    const startOrdinal = Math.min(...summaryItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
      .filter(
        (item) =>
          item.ordinal < startOrdinal &&
          item.itemType === "summary" &&
          typeof item.summaryId === "string",
      )
      .slice(-4);
    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary || summary.depth !== targetDepth) {
        continue;
      }
      const content = summary.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }
    return summaryContents.slice(-2).join("\n\n");
  }

  /**
   * Run three-level summarization escalation:
   * normal -> aggressive -> deterministic fallback.
   *
   * Exhausted output-cut retries halve at source boundaries, at most
   * MAX_CUT_SPLIT_DEPTH times, down to deterministic truncation of a piece that is
   * still cut (a single message, a condensed source summary, or a piece at the depth
   * limit). A split visits at most 2·min(n, 8) - 1 chunks for n sources. Rejected
   * answers never supply text.
   * Whitespace and other provider failures still abort before persistence.
   */
  private async summarizeWithEscalation(params: EscalationParams): Promise<EscalationResult> {
    this.config.signal?.throwIfAborted();
    const rawText = params.sourceTexts.join("\n\n").trim();
    const sourceText = this.config.scrubber ? this.config.scrubber.scrub(rawText) : rawText;
    if (!sourceText) {
      return {
        content: "[Truncated from 0 tokens]",
        level: "fallback",
        keptAnswers: 0,
      };
    }
    const inputTokens = Math.max(1, estimateTokens(sourceText));
    const fallback = (): EscalationResult => ({
      content: `${sourceText.slice(0, FALLBACK_MAX_CHARS)}\n[Truncated from ${inputTokens} tokens]`,
      level: "fallback",
      keptAnswers: 0,
    });
    const lessons = params.sourceMessageIds
      ? await this.conversationStore.getToolLessonsForMessages(params.sourceMessageIds) : [];
    const toolContext = boundToolSummaryContext({
      errorFixPairs: lessons.filter(lesson => lesson.kind === "error-fix").map(lesson => ({
        failedCommand: lesson.failedCommand!, succeededCommand: lesson.succeededCommand!,
      })),
      blocked: lessons.filter(lesson => lesson.kind === "block-reason").map(lesson => ({
        command: lesson.command, reason: lesson.reason,
      })),
    }, this.config.scrubber ? text => this.config.scrubber!.scrub(text) : undefined);
    const summarizeOptions = {
      ...params.options,
      ...(this.config.language?.trim() ? { language: this.config.language.trim() } : {}),
      ...(toolContext ? { toolContext } : {}),
    };

    const summarizeGated = async (aggressive: boolean) =>
      acceptSummaryText(await params.summarize(sourceText, aggressive, summarizeOptions), "summarizer");

    try {
      return await this.escalate(summarizeGated, inputTokens, fallback);
    } catch (error) {
      if (!containsOutputCut(error)) throw error;
      const depth = params.splitDepth ?? 0;
      if (params.sourceTexts.length <= 1 || depth >= MAX_CUT_SPLIT_DEPTH) return fallback();
      return this.summarizeHalves({ ...params, splitDepth: depth + 1 }, inputTokens, fallback);
    }
  }

  /** Normal, then aggressive when the answer did not shrink, then the deterministic fallback. */
  private async escalate(
    summarizeGated: (aggressive: boolean) => Promise<string>,
    inputTokens: number,
    fallback: () => EscalationResult,
  ): Promise<EscalationResult> {
    const normal = await summarizeGated(false);
    if (estimateTokens(normal) < inputTokens) return { content: normal, level: "normal", keptAnswers: 1 };
    this.config.onAnswerDiscarded?.();
    const aggressive = await summarizeGated(true);
    if (estimateTokens(aggressive) < inputTokens) return { content: aggressive, level: "aggressive", keptAnswers: 1 };
    this.config.onAnswerDiscarded?.();
    return fallback();
  }

  /** Each half of the sources through the full escalation, joined in order; a join that does not shrink falls back. */
  private async summarizeHalves(
    params: EscalationParams,
    inputTokens: number,
    fallback: () => EscalationResult,
  ): Promise<EscalationResult> {
    const midpoint = Math.floor(params.sourceTexts.length / 2);
    const left = await this.summarizeWithEscalation({
      ...params, sourceTexts: params.sourceTexts.slice(0, midpoint),
      sourceMessageIds: params.sourceMessageIds?.slice(0, midpoint),
    });
    const right = await this.summarizeWithEscalation({
      ...params,
      sourceTexts: params.sourceTexts.slice(midpoint),
      sourceMessageIds: params.sourceMessageIds?.slice(midpoint),
      options: { ...params.options, previousSummary: left.content },
    });
    const content = `${left.content}\n\n${right.content}`;
    const keptAnswers = left.keptAnswers + right.keptAnswers;
    if (estimateTokens(content) >= inputTokens) {
      for (let i = 0; i < keptAnswers; i++) this.config.onAnswerDiscarded?.();
      return fallback();
    }
    return { content, level: highestLevel(left.level, right.level), keptAnswers };
  }

  // ── Private: Leaf Pass ───────────────────────────────────────────────────

  /**
   * Summarize a chunk of messages into one leaf summary.
   */
  private async leafPass(
    conversationId: number,
    messageItems: ContextItemRecord[],
    summarize: CompactionSummarizeFn,
    previousSummaryContent?: string,
  ): Promise<PassResult & { content: string }> {
    // Fetch full message content for each context item
    const messageContents: { messageId: number; content: string; createdAt: Date; eventAt?: Date | null; tokenCount: number }[] =
      [];
    let replacedTokens = 0;
    let processed = 0;
    for (const item of messageItems) {
      if (processed++ % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      if (item.messageId == null) {
        continue;
      }
      const msg = await this.conversationStore.getMessageById(item.messageId);
      if (msg) {
        replacedTokens += msg.tokenCount ?? 0;
        messageContents.push({
          messageId: msg.messageId,
          content: msg.content,
          createdAt: msg.eventAt ?? msg.createdAt,
          eventAt: msg.eventAt,
          tokenCount: this.resolveMessageTokenCount(msg),
        });
      }
    }

    const sourceTexts: string[] = [];
    for (let i = 0; i < messageContents.length; i++) {
      if (i % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      const message = messageContents[i];
      sourceTexts.push(`[${formatTimestamp(message.createdAt, this.config.timezone)}]\n${message.content}`);
    }
    const fileIds = dedupeOrderedIds(
      messageContents.flatMap((message) => extractFileIdsFromContent(message.content)),
    );
    const summary = await this.summarizeWithEscalation({
      sourceTexts,
      sourceMessageIds: messageContents.map(message => message.messageId),
      summarize,
      options: {
        previousSummary: previousSummaryContent,
        isCondensed: false,
      },
    });

    // Persist the leaf summary
    this.config.signal?.throwIfAborted();
    const summaryId = generateSummaryId(summary.content);
    const tokenCount = estimateTokens(summary.content);
    const dated = messageContents.filter(message => message.eventAt);
    const bounds = dated.length ? dated : messageContents;

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "leaf",
      hasEventTime: dated.length > 0,
      depth: 0,
      content: summary.content,
      tokenCount,
      fileIds,
      earliestAt:
        bounds.length > 0
          ? new Date(Math.min(...bounds.map((message) => message.createdAt.getTime())))
          : undefined,
      latestAt:
        bounds.length > 0
          ? new Date(Math.max(...bounds.map((message) => message.createdAt.getTime())))
          : undefined,
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: messageContents.reduce(
        (sum, message) => sum + Math.max(0, Math.floor(message.tokenCount)),
        0,
      ),
    });

    // Link to source messages
    const messageIds = messageContents.map((m) => m.messageId);
    await this.summaryStore.linkSummaryToMessages(summaryId, messageIds);

    // Replace the message range in context with the new summary
    const ordinals = messageItems.map((ci) => ci.ordinal);
    const startOrdinal = Math.min(...ordinals);
    const endOrdinal = Math.max(...ordinals);

    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal,
      endOrdinal,
      summaryId,
    });

    return { summaryId, level: summary.level, content: summary.content, tokenDelta: tokenCount - replacedTokens };
  }

  // ── Private: Condensed Pass ──────────────────────────────────────────────

  /**
   * Condense one ratio-sized summary chunk into a single condensed summary.
   */
  private async condensedPass(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    targetDepth: number,
    summarize: CompactionSummarizeFn,
  ): Promise<PassResult> {
    // Fetch full summary records
    const summaryRecords: SummaryRecord[] = [];
    let processed = 0;
    for (const item of summaryItems) {
      if (processed++ % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      if (item.summaryId == null) {
        continue;
      }
      const rec = await this.summaryStore.getSummary(item.summaryId);
      if (rec) {
        summaryRecords.push(rec);
      }
    }

    const sourceTexts: string[] = [];
    for (let i = 0; i < summaryRecords.length; i++) {
      if (i % COMPACTION_YIELD_EVERY === 0) await yieldToEventLoop();
      const summary = summaryRecords[i];
      const earliestAt = summary.earliestAt ?? summary.createdAt;
      const latestAt = summary.latestAt ?? summary.createdAt;
      const tz = this.config.timezone;
      const header = `[${formatTimestamp(earliestAt, tz)} - ${formatTimestamp(latestAt, tz)}]`;
      sourceTexts.push(`${header}\n${summary.content}`);
    }
    const fileIds = dedupeOrderedIds(
      summaryRecords.flatMap((summary) => [
        ...summary.fileIds,
        ...extractFileIdsFromContent(summary.content),
      ]),
    );
    const previousSummaryContent =
      targetDepth === 0
        ? await this.resolvePriorSummaryContextAtDepth(conversationId, summaryItems, targetDepth)
        : undefined;
    const condensed = await this.summarizeWithEscalation({
      sourceTexts,
      summarize,
      options: {
        previousSummary: previousSummaryContent,
        isCondensed: true,
        depth: targetDepth + 1,
      },
    });

    // Persist the condensed summary
    this.config.signal?.throwIfAborted();
    const summaryId = generateSummaryId(condensed.content);
    const tokenCount = estimateTokens(condensed.content);
    const knownBounds = this.summaryStore.getSourceEventTimeBounds(summaryRecords.map(summary => summary.summaryId));

    await this.summaryStore.insertSummary({
      summaryId,
      conversationId,
      kind: "condensed",
      hasEventTime: knownBounds !== null,
      depth: targetDepth + 1,
      content: condensed.content,
      tokenCount,
      fileIds,
      earliestAt:
        knownBounds?.earliestAt ?? (summaryRecords.length > 0
          ? new Date(
              Math.min(
                ...summaryRecords.map((summary) =>
                  (summary.earliestAt ?? summary.createdAt).getTime(),
                ),
              ),
            )
          : undefined),
      latestAt:
        knownBounds?.latestAt ?? (summaryRecords.length > 0
          ? new Date(
              Math.max(
                ...summaryRecords.map((summary) => (summary.latestAt ?? summary.createdAt).getTime()),
              ),
            )
          : undefined),
      descendantCount: summaryRecords.reduce((count, summary) => {
        const childDescendants =
          typeof summary.descendantCount === "number" && Number.isFinite(summary.descendantCount)
            ? Math.max(0, Math.floor(summary.descendantCount))
            : 0;
        return count + childDescendants + 1;
      }, 0),
      descendantTokenCount: summaryRecords.reduce((count, summary) => {
        const childDescendantTokens =
          typeof summary.descendantTokenCount === "number" &&
          Number.isFinite(summary.descendantTokenCount)
            ? Math.max(0, Math.floor(summary.descendantTokenCount))
            : 0;
        return count + Math.max(0, Math.floor(summary.tokenCount)) + childDescendantTokens;
      }, 0),
      sourceMessageTokenCount: summaryRecords.reduce((count, summary) => {
        const sourceTokens =
          typeof summary.sourceMessageTokenCount === "number" &&
          Number.isFinite(summary.sourceMessageTokenCount)
            ? Math.max(0, Math.floor(summary.sourceMessageTokenCount))
            : 0;
        return count + sourceTokens;
      }, 0),
    });

    // Link to parent summaries
    const parentSummaryIds = summaryRecords.map((s) => s.summaryId);
    await this.summaryStore.linkSummaryToParents(summaryId, parentSummaryIds);

    // Replace all summary items in context with the condensed summary
    const ordinals = summaryItems.map((ci) => ci.ordinal);
    const startOrdinal = Math.min(...ordinals);
    const endOrdinal = Math.max(...ordinals);

    await this.summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal,
      endOrdinal,
      summaryId,
    });

    return { summaryId, level: condensed.level, tokenDelta: tokenCount - summaryRecords.reduce((sum, source) => sum + source.tokenCount, 0) };
  }

  /**
   * Persist durable compaction events into canonical history as message parts.
   *
   * Event persistence is best-effort: failures are swallowed to avoid
   * compromising the core compaction path.
   */
  private async persistCompactionEvents(input: {
    conversationId: number;
    tokensBefore: number;
    tokensAfterLeaf: number;
    tokensAfterFinal: number;
    leafResult: { summaryId: string; level: CompactionLevel } | null;
    condenseResult: { summaryId: string; level: CompactionLevel } | null;
  }): Promise<void> {
    const {
      conversationId,
      tokensBefore,
      tokensAfterLeaf,
      tokensAfterFinal,
      leafResult,
      condenseResult,
    } = input;

    if (!leafResult && !condenseResult) {
      return;
    }

    const conversation = await this.conversationStore.getConversation(conversationId);
    if (!conversation) {
      return;
    }

    const createdSummaryIds = [leafResult?.summaryId, condenseResult?.summaryId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const condensedPassOccurred = condenseResult !== null;

    if (leafResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "leaf",
        level: leafResult.level,
        tokensBefore,
        tokensAfter: tokensAfterLeaf,
        createdSummaryId: leafResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }

    if (condenseResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "condensed",
        level: condenseResult.level,
        tokensBefore: tokensAfterLeaf,
        tokensAfter: tokensAfterFinal,
        createdSummaryId: condenseResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }
  }

  /** Write one compaction event message + part atomically where possible. */
  private async persistCompactionEvent(input: {
    conversationId: number;
    sessionId: string;
    pass: CompactionPass;
    level: CompactionLevel;
    tokensBefore: number;
    tokensAfter: number;
    createdSummaryId: string;
    createdSummaryIds: string[];
    condensedPassOccurred: boolean;
  }): Promise<void> {
    const content = `LCM compaction ${input.pass} pass (${input.level}): ${input.tokensBefore} -> ${input.tokensAfter}`;
    const metadata = JSON.stringify({
      conversationId: input.conversationId,
      pass: input.pass,
      level: input.level,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      createdSummaryId: input.createdSummaryId,
      createdSummaryIds: input.createdSummaryIds,
      condensedPassOccurred: input.condensedPassOccurred,
    });

    const writeEvent = async (): Promise<void> => {
      const seq = (await this.conversationStore.getMaxSeq(input.conversationId)) + 1;
      const eventMessage = await this.conversationStore.createMessage({
        conversationId: input.conversationId,
        seq,
        role: "system",
        content,
        tokenCount: estimateTokens(content),
      });

      const parts: CreateMessagePartInput[] = [
        {
          sessionId: input.sessionId,
          partType: "compaction",
          ordinal: 0,
          textContent: content,
          metadata,
        },
      ];
      await this.conversationStore.createMessageParts(eventMessage.messageId, parts);
    };

    try {
      await this.conversationStore.withTransaction(() => writeEvent());
    } catch {
      // Compaction should still succeed if event persistence fails.
    }
  }
}
