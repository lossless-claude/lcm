/**
 * Why a summarizer answer is not a summary:
 * - `length`: an OpenAI-compatible endpoint stopped at `max_tokens` (`finish_reason: "length"`).
 * - `max_tokens`: Anthropic stopped at `max_tokens` (`stop_reason: "max_tokens"`).
 * - `whitespace`: the answer holds no text.
 *
 * A reasoning model can spend the whole output budget thinking, so a length stop
 * returns a cut-off tail that reads like text but is not the summary the model meant.
 */
export type SummaryRejectionReason = "length" | "max_tokens" | "whitespace";

/**
 * The model answered, but the answer must not be persisted. Adapters throw it after
 * reporting usage (the tokens were charged); the compaction engine throws it for any
 * provider's whitespace answer. Rejected answer text is never stored; output-cut
 * recovery may instead truncate the original source deterministically.
 */
export class SummaryRejectedError extends Error {
  readonly reason: SummaryRejectionReason;
  readonly provider: string;
  readonly model?: string;
  /** The output cap the answer stopped at, for a `length` or `max_tokens` stop. */
  readonly maxOutputTokens?: number;

  constructor(opts: {
    reason: SummaryRejectionReason; provider: string; model?: string; detail?: string; maxOutputTokens?: number;
  }) {
    const who = opts.model ? `${opts.provider} (${opts.model})` : opts.provider;
    super(`summary rejected: ${who} ${describe(opts.reason)}${opts.detail ? ` (${opts.detail})` : ""}`);
    this.name = "SummaryRejectedError";
    this.reason = opts.reason;
    this.provider = opts.provider;
    this.model = opts.model;
    this.maxOutputTokens = opts.maxOutputTokens;
  }

  /**
   * A length stop repeats for the same request and budget, so an adapter retries only an
   * empty answer. The provider chain retries a length stop once, with a changed request.
   */
  get retryable(): boolean {
    return this.reason === "whitespace";
  }
}

/** Content-free diagnostics for one answer stopped at its output cap. */
export type SummaryCutDiagnostic = {
  reason: "length" | "max_tokens";
  provider: string;
  model?: string;
  maxOutputTokens: number;
  outputTokens?: number;
  tailRepetition: number;
};

/** Share of four-word windows repeated earlier in the last 256 words (at most 8 KiB). */
function tailRepetition(text: unknown): number {
  if (typeof text !== "string" || !text.trim()) return 0;
  const words = text.slice(-8_192).trim().toLowerCase().split(/\s+/).slice(-256);
  const windows = words.length - 3;
  if (windows <= 0) return 0;
  const seen = new Set<string>();
  let repeated = 0;
  for (let i = 0; i < windows; i++) {
    const gram = words.slice(i, i + 4).join(" ");
    if (seen.has(gram)) repeated++;
    seen.add(gram);
  }
  return repeated / windows;
}

/** Report only measurements, then reject; neither the diagnostic nor the error retains text. */
export function rejectCutSummary(
  opts: Omit<SummaryCutDiagnostic, "tailRepetition"> & { text: unknown },
  onCut?: (diagnostic: SummaryCutDiagnostic) => void,
): never {
  const { text, ...diagnostic } = opts;
  onCut?.({ ...diagnostic, tailRepetition: tailRepetition(text) });
  throw new SummaryRejectedError(diagnostic);
}

function describe(reason: SummaryRejectionReason): string {
  if (reason === "whitespace") return "returned empty content";
  return `stopped at the output token limit (${reason === "length" ? "finish_reason" : "stop_reason"} "${reason}")`;
}

/** Returns `text` unchanged when it holds a summary; throws `SummaryRejectedError` otherwise. */
export function acceptSummaryText(text: string, provider: string, model?: string): string {
  if (typeof text !== "string" || !text.trim()) {
    throw new SummaryRejectedError({ reason: "whitespace", provider, model });
  }
  return text;
}
