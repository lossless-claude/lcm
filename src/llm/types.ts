export type SummarizerProvider = "claude-process" | "codex-process" | "copilot-process";

/**
 * Normalized token accounting, shared by every process-backed summarizer.
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
  provider: SummarizerProvider;
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  tokensUsed: number;
  /** Claude CLI only — list-price cost of the call. */
  costUsd?: number;
  /** Copilot CLI only — GitHub's billing unit, not a token count. */
  premiumRequests?: number;
};

export type SummarizeContext = {
  /** Internal alternate task: send text verbatim with this system instruction. */
  taskPrompt?: string;
  isCondensed?: boolean;
  targetTokens?: number;
  depth?: number;
  onUsage?: (usage: SummarizerUsage) => void;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
