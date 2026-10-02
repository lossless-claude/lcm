import type { SessionClient } from "../session-client.js";

export type SummarizerProvider =
  | "claude-process"
  | "codex-process"
  | "copilot-process"
  | "omp-process"
  | "openai"
  | "anthropic"
  | "session:haiku"
  | "session:fork";

/**
 * Normalized token accounting, shared by every summarizer that reports it.
 *
 * Conventions (pinned so numbers stay comparable across providers):
 * - `inputTokens` is the FULL prompt cost, cached portion included.
 * - `cachedInputTokens` is a SUBSET of `inputTokens`, never additive.
 * - `tokensUsed` is `inputTokens + outputTokens`, which preserves the value
 *   the Codex CLI itself prints as "tokens used".
 *
 * Fields a provider cannot report are left undefined rather than zeroed, so
 * callers can tell "no cache" apart from "cache not reported".
 */
export type SummarizerUsage = {
  /** The adapter's own label, or the endpoint's name when it is one of `llm.providers`. */
  provider: SummarizerProvider | (string & {});
  model?: string;
  estimated?: boolean;
  /** A reported attempt that spent tokens but did not produce a usable answer. */
  failed?: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  tokensUsed: number;
  /**
   * Charged cost of the call, when the provider prices it: the Claude CLI
   * reports list price, OpenRouter the real charge. Absent means UNKNOWN,
   * never free — a consumer must not read a missing cost as zero.
   */
  costUsd?: number;
  /** Copilot CLI only — GitHub's billing unit, not a token count. */
  premiumRequests?: number;
  /** Endpoint-reported phase durations, in milliseconds. */
  prefillMs?: number;
  decodeMs?: number;
  /** The billed answer was rejected, even if an adapter later recovered. */
  rejectionReason?: "length" | "max_tokens" | "whitespace";
};

export type SummarizeContext = {
  /** An expired compaction must not enqueue or publish another attempt. */
  signal?: AbortSignal;
  /** Endpoint slot admission; live by default, background for bulk compaction. */
  workClass?: "live" | "background" | "timeline";
  /** Internal alternate task: send text verbatim with this system instruction. */
  taskPrompt?: string;
  /** BCP 47 language tag for generated summary text, when configured or detected. */
  language?: string;
  sessionId?: string;
  client?: SessionClient | "copilot";
  isCondensed?: boolean;
  targetTokens?: number;
  /** The request's output cap, in place of the one `targetTokens` implies. */
  maxOutputTokens?: number;
  depth?: number;
  /** The preceding chunk's summary, rendered into the prompt so chunks read as one thread. */
  previousSummary?: string;
  onUsage?: (usage: SummarizerUsage) => void;
  /**
   * A chain link is about to run: its name (the usage label it reports under), how it
   * reaches its model, and the model it is configured with. Fires even for a link whose
   * response carries no usage, so a caller can still name and count the attempt.
   */
  onAttempt?: (attempt: { provider: string; kind: "session" | "http" | "process"; model?: string }) => void;
  /**
   * `fromProvider` did not produce a summary; `toProvider` is summarizing instead. The two
   * are the same link when it retries its own answer that stopped at the output cap.
   */
  onFallback?: (fallback: { reason: string; fromProvider: string; toProvider: string }) => void;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
