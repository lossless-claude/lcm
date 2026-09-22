/**
 * The seam between a harness's tool ids and the passive-learning extractor.
 *
 * A harness reports its own tool vocabulary — Codex's `update_plan`, Oh My Pi's `todo` —
 * while the extractor has one fixed set of shapes ({@link EXTRACTOR_TOOL_NAMES}). Each
 * harness owns a table that says what its ids mean; this module owns what a table means,
 * so a new harness adds data rather than another bespoke renamer.
 *
 * A table entry has three possible outcomes, and the difference is the point:
 *
 * - **mapped** — translate to a canonical name, optionally rewriting the payload into the
 *   fields the extractor reads;
 * - **silent** — this id has no success shape, and the entry says why so the next reader
 *   does not re-open the question, and so a reviewer can see the coverage is deliberate;
 * - **absent** — the harness has no opinion at all.
 *
 * A silent entry and an absent one both pass the call through untouched, and so does a
 * mapper that declines a payload too thin for its shape. Translation therefore never
 * discards a call: the extractor still sees it under its original name, where the generic
 * arms (a failure, at least) can act on it. What a mapper's `undefined` buys is the absence
 * of a *shaped* event — a row with empty data is worse than no row.
 *
 * Harnesses that cannot import this module — a hook the host loads in-process, with no
 * package resolution — inline the table and are held to it by test instead: the hook is
 * driven through this seam and then through the real extractor.
 */

import type { CanonicalToolName } from "./extractors.js";

export type { CanonicalToolName };

/** One tool call as its host reported it. */
export interface HarnessToolCall {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly response?: unknown;
}

/**
 * What the harness says this tool means. `input` may decline by returning `undefined`
 * when the payload carried nothing the extractor can use — a row with empty data is
 * worse than no row, and every mapper that could meet a thin payload must consider it.
 */
export type ToolMapping =
  | {
      readonly canonical: CanonicalToolName;
      readonly input?: (call: HarnessToolCall) => Record<string, unknown> | undefined;
    }
  | { readonly silent: string };

/** One harness's tool ids. */
export type ToolVocabulary = Readonly<Record<string, ToolMapping>>;

export interface TranslatedToolCall {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
}

/**
 * Translate one harness tool call for the extractor.
 *
 * Never discards a call: an id the harness has no mapping for, an id it declares silent,
 * and a payload its mapper declines all pass through under the harness's own name, where
 * the extractor's generic arms can still act on them.
 */
export function translateToolCall(
  vocabulary: ToolVocabulary,
  call: HarnessToolCall,
): TranslatedToolCall {
  const passthrough = (): TranslatedToolCall => ({ tool_name: call.toolName, tool_input: { ...call.input } });
  const mapping = vocabulary[call.toolName];
  if (!mapping || "silent" in mapping) return passthrough();

  const input = mapping.input ? mapping.input(call) : call.input;
  return input === undefined ? passthrough() : { tool_name: mapping.canonical, tool_input: input };
}
