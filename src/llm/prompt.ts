import type { SummarizeContext } from "./types.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

/** The summarization prompt, without the system preamble. */
export function buildSummaryPrompt(
  text: string,
  aggressive: boolean | undefined,
  ctx: SummarizeContext,
): string {
  if (ctx.taskPrompt !== undefined) return text;
  const estimatedInputTokens = Math.ceil(text.length / 4);
  const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
    inputTokens: estimatedInputTokens,
    mode: aggressive ? "aggressive" : "normal",
    isCondensed: ctx.isCondensed ?? false,
    condensedTargetTokens: 2000,
  });

  return ctx.isCondensed
    ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
    : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });
}

/** The same prompt with the system preamble prepended, for CLIs with no system-prompt flag. */
export function buildSummaryPromptWithSystem(
  text: string,
  aggressive: boolean | undefined,
  ctx: SummarizeContext,
): string {
  return [ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT, buildSummaryPrompt(text, aggressive, ctx)]
    .filter(Boolean)
    .join("\n\n");
}
