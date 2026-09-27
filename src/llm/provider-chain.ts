import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { acceptSummaryText, SummaryRejectedError } from "./summary-rejection.js";

/**
 * How a link reaches its model, which decides what counts as "try the next one":
 * - `session`: the live session's own client, through the function-hooks module.
 * - `http`: an OpenAI-compatible or Anthropic endpoint, through its client library.
 * - `process`: a CLI run as a child process, authenticated by its own login.
 */
export type ProviderLinkKind = "session" | "http" | "process";

/** One summarizer in a chain, as it resolves for one call. */
export type ResolvedLink = {
  /** Reported in `onFallback` and in the exhaustion error. */
  name: string;
  kind: ProviderLinkKind;
  /** When set, replaces the adapter's own `provider` label on every usage it reports. */
  usageLabel?: string;
  /** The model the link is configured with, when it names one. */
  model?: string;
  /** Created on first use: a link that is never reached never loads its client library. */
  summarizer: () => Promise<LcmSummarizeFn>;
};

/** A chain link; `auto` resolves by the calling client, so resolution takes the call's context. */
export type ProviderLink = (ctx: SummarizeContext) => ResolvedLink;

/** The live session did not answer: no module, a timeout, an error, or no session at all. */
export class SessionUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SessionUnavailableError";
  }
}

/**
 * No link of the chain can run: every endpoint in it references an environment
 * variable that was unset when the config loaded. Thrown when a summary is asked
 * for, so the rest of the daemon keeps running.
 */
export class SummarizerUnavailableError extends Error {
  constructor(readonly unavailable: ReadonlyArray<{ name: string; missingEnv: readonly string[] }>) {
    super("no summarizer can run: " +
      unavailable.map(({ name, missingEnv }) => `${name} needs ${missingEnv.join(", ")}`).join("; ") +
      ", unset in the daemon's environment");
    this.name = "SummarizerUnavailableError";
  }
}

/** Every link of the chain failed in a way that allowed the next one to run. */
export class ProviderChainExhaustedError extends Error {
  readonly failures: ReadonlyArray<{ provider: string; error: unknown }>;

  constructor(failures: ReadonlyArray<{ provider: string; error: unknown }>) {
    super(`every summarizer failed: ${failures.map(({ provider, error }) => `${provider}: ${messageOf(error)}`).join("; ")}`);
    this.name = "ProviderChainExhaustedError";
    this.failures = failures;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET"]);
const CONNECTION_ERRORS = new Set(["APIConnectionError", "APIConnectionTimeoutError"]);

function isNetworkError(error: any): boolean {
  if (CONNECTION_ERRORS.has(error?.constructor?.name)) return true;
  return NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code);
}

/**
 * An HTTP failure worth the next endpoint: the endpoint refused this key (401/403)
 * or stayed unavailable through the adapter's retries (408, 429, 5xx, no connection).
 * A 400 or 422 is a request the next endpoint would build the same way, so it stops.
 */
function httpFailureAdvances(error: any): boolean {
  const status = error?.status;
  if (typeof status !== "number") return isNetworkError(error);
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/**
 * Whether a link's failure hands the call to the next link. Everything not named
 * here stops the chain: configuration errors, a 400, a cancelled request, an
 * exception nobody classified. Trying the next endpoint would hide those.
 */
export function failureAdvancesChain(error: unknown, kind: ProviderLinkKind): boolean {
  if (error instanceof SummaryRejectedError) return true;
  if (kind === "session") return error instanceof SessionUnavailableError;
  // The process adapters report every failure of the CLI run as an Error of their own.
  if (kind === "process") return error instanceof Error;
  return httpFailureAdvances(error);
}

function withUsageLabel(ctx: SummarizeContext, label: string | undefined): SummarizeContext {
  const onUsage = ctx.onUsage;
  if (!label || !onUsage) return ctx;
  return { ...ctx, onUsage: (usage: SummarizerUsage) => onUsage({ ...usage, provider: label }) };
}

/** Links repeated by name (an env-selected primary also listed as a fallback) run once. */
function resolveLinks(links: ProviderLink[], ctx: SummarizeContext): ResolvedLink[] {
  const seen = new Set<string>();
  return links.map((link) => link(ctx)).filter((link) => !seen.has(link.name) && Boolean(seen.add(link.name)));
}

/**
 * Runs the links in order, each at most once per call, until one returns a summary.
 * `ctx.onFallback` fires between links, which is where a caller settles the abandoned
 * attempt. A failure that does not advance is thrown as is; when a second link has
 * run and every link failed, the failures are thrown together.
 */
export function createProviderChain(links: ProviderLink[]): LcmSummarizeFn {
  return async (text, aggressive, ctx = {}) => {
    const resolved = resolveLinks(links, ctx);
    const failures: { provider: string; error: unknown }[] = [];
    for (const [i, link] of resolved.entries()) {
      const outcome = await runLink(link, [text, aggressive, ctx]);
      if ("summary" in outcome) return outcome.summary;
      if (!failureAdvancesChain(outcome.error, link.kind)) throw outcome.error;
      failures.push({ provider: link.name, error: outcome.error });
      const next = resolved[i + 1];
      if (next) ctx.onFallback?.({ reason: messageOf(outcome.error), fromProvider: attemptName(link), toProvider: next.name });
    }
    if (failures.length === 1) throw failures[0].error;
    throw new ProviderChainExhaustedError(failures);
  };
}

/** The name a link's attempt is reported under: its usage label, or its own name. */
function attemptName(link: ResolvedLink): string {
  return link.usageLabel ?? link.name;
}

async function runLink(
  link: ResolvedLink, [text, aggressive, ctx]: [string, boolean | undefined, SummarizeContext],
): Promise<{ summary: string } | { error: unknown }> {
  ctx.onAttempt?.({ provider: attemptName(link), kind: link.kind, ...(link.model ? { model: link.model } : {}) });
  try {
    const summarize = await link.summarizer();
    const answer = await summarize(text, aggressive, withUsageLabel(ctx, link.usageLabel));
    // Judged inside the link, after the adapter reported its usage: an answer with no
    // text moves the chain on. The process adapters return whatever their CLI printed.
    return { summary: acceptSummaryText(answer, attemptName(link)) };
  } catch (error) {
    return { error };
  }
}
