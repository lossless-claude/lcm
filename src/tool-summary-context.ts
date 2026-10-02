import { truncateToolInput } from "./tool-calls.js";

/** Maximum serialized UTF-8 bytes beside the conversation; fixed prompt instructions are separate. */
export const TOOL_SUMMARY_CONTEXT_BYTES = 8192;

/** Evidence from calls in this leaf window, separate from conversation text. */
export type ToolSummaryContext = {
  errorFixPairs: { failedCommand: string; succeededCommand: string }[];
  blockReasons: string[];
  /** Evidence entries omitted to keep the structured input within its byte budget. */
  omitted?: number;
};

/** Keep complete pairs, cap commands like stored inputs, and reserve space for the omitted count. */
export function boundToolSummaryContext(
  input: ToolSummaryContext | undefined, scrub: (text: string) => string = text => text,
): ToolSummaryContext | undefined {
  if (!input || (!input.errorFixPairs.length && !input.blockReasons.length)) return undefined;
  const context: ToolSummaryContext = {
    errorFixPairs: [], blockReasons: [],
    omitted: (input.omitted ?? 0) + input.errorFixPairs.length + input.blockReasons.length,
  };
  const fits = () => Buffer.byteLength(JSON.stringify(context)) <= TOOL_SUMMARY_CONTEXT_BYTES;
  for (const pair of input.errorFixPairs) {
    context.errorFixPairs.push({
      failedCommand: truncateToolInput(scrub(pair.failedCommand)),
      succeededCommand: truncateToolInput(scrub(pair.succeededCommand)),
    });
    if (fits()) context.omitted = context.omitted! - 1;
    else context.errorFixPairs.pop();
  }
  for (const reason of input.blockReasons) {
    context.blockReasons.push(truncateToolInput(scrub(reason)));
    if (fits()) context.omitted = context.omitted! - 1;
    else context.blockReasons.pop();
  }
  return context;
}
