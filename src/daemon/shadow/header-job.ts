import { COMPACTION_HEADER_SECTIONS, compactionHeaderItems, validCompactionHeader, type CompactionHeader, type HeaderSource } from "../../../hooks/compaction-header-schema.js";
import { assembleExcerpts, checkExcerpts, fitExcerpts, renderExcerpts, type UserExcerpt } from "../../compaction-header/excerpts.js";
import { renderTemplate } from "../../prompts/loader.js";
import { fenceContent } from "../content-fence.js";
import { verifyNativeTail } from "./tail.js";
import { objectHash } from "./types.js";
import type { ContextWindowItem } from "../../store/summary-store.js";
import type { ShadowMessage, ShadowOriginal } from "./types.js";

export type HeaderJobInput = { cutId: string; instructions: string; originals: readonly ShadowOriginal[]; window: readonly ContextWindowItem[]; tail: readonly ShadowMessage[]; engineMessages: readonly ShadowMessage[] };
export const HEADER_WORD_TARGET = 750;
export const DOCUMENT_BYTE_TARGET = 65_536;
export type PreparedHeaderJob = {
  version: 1; cutId: string; excerpts: UserExcerpt[]; window: ContextWindowItem[]; tail: ShadowMessage[];
  forkPrompt: string; completePrompt: string; promptHash: string; forkPromptHash: string; inputHash: string;
  excerptOverflowBytes: number; omittedExcerptIds: number[];
};
export function prepareHeaderJob(input: HeaderJobInput, { excerptTargetBytes = 4096 } = {}): PreparedHeaderJob {
  verifyNativeTail(input.tail, input.engineMessages, text => text);
  const selection = assembleExcerpts(input.originals, input.cutId, { targetBytes: Number.MAX_SAFE_INTEGER });
  if (checkExcerpts(selection.excerpts, input.originals, input.cutId).length) throw new Error("Non-verbatim excerpt");
  const window = input.window.map(row => ({ ...row })).sort((a, b) => a.ordinal - b.ordinal);
  const tail = input.tail.map(row => ({ ...row }));
  const shared = { instructions: input.instructions, excerpts: selection.excerpts.map(row => ({ ...row, pointer: `[excerpt:${row.id}]` })) };
  const evidence = { ...shared, window: renderWindow(window, input.cutId), tail };
  const completePrompt = prompt(evidence), forkPrompt = prompt({ ...shared, transcript: "Use your existing fork prefix; no digested window is supplied." });
  return { version: 1, cutId: input.cutId, excerpts: selection.excerpts, window, tail, completePrompt, forkPrompt,
    inputHash: objectHash(evidence), promptHash: objectHash(completePrompt), forkPromptHash: objectHash(forkPrompt),
    excerptOverflowBytes: Math.max(0, selection.bytes - excerptTargetBytes), omittedExcerptIds: selection.omittedIds };
}
function prompt(evidence: unknown): string {
  return renderTemplate("compaction-header", { word_target: String(HEADER_WORD_TARGET), evidence: fenceContent(JSON.stringify(evidence), "compaction-evidence") });
}
function renderWindow(window: readonly ContextWindowItem[], cutId: string): string {
  return window.map(row => row.itemType === "summary" ? `[sum:${row.summaryId}]\n${row.content}`
    : `[raw:${cutId}:${row.messageId}] ${row.role}:\n${row.content}`).join("\n\n");
}
const TITLES = ["Current intent", "Instructions in force", "Decisions", "Task state", "How the work is being done", "Next steps", "Open threads", "Files", "Errors and fixes"];
const sourceText = (source: HeaderSource) => typeof source === "string" ? source : JSON.stringify(source);
export function renderWorkingHeader(header: CompactionHeader): string {
  if (!validCompactionHeader(header)) throw new Error("Invalid working-state header");
  return COMPACTION_HEADER_SECTIONS.map((key, index) => `## ${TITLES[index]}\n` + header[key].map(item => renderItem(item)).join("\n")).join("\n\n");
}
function renderItem(item: CompactionHeader[typeof COMPACTION_HEADER_SECTIONS[number]][number]): string {
  const fields = Object.entries(item).filter(([key]) => key !== "sources").map(([key, value]) =>
    key === "supersedes" ? `supersedes: ${(value as HeaderSource[]).map(sourceText).join(" ")}` : `${key}: ${value}`);
  return [...fields, item.sources.map(sourceText).join(" ")].join("\n");
}
function documentText(job: PreparedHeaderJob, header: string, { window, excerpts = job.excerpts }: { window: readonly ContextWindowItem[]; excerpts?: UserExcerpt[] }): string {
  return [renderExcerpts(excerpts), header, `## Window\n${renderWindow(window, job.cutId)}`,
    `## Engine tail\n${job.tail.map(row => `${row.role}:\n${row.text}`).join("\n\n")}`].join("\n\n");
}
export function renderCompactionDocument(job: PreparedHeaderJob, header: CompactionHeader, { targetBytes = DOCUMENT_BYTE_TARGET } = {}) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) throw new Error("Invalid document size target");
  const rendered = renderWorkingHeader(header), omittedSummaryIds: string[] = [];
  let window = job.window, text = documentText(job, rendered, { window });
  for (const row of job.window) {
    if (Buffer.byteLength(text, "utf8") <= targetBytes) break;
    if (row.itemType !== "summary") continue;
    omittedSummaryIds.push(row.summaryId!);
    window = window.filter(item => item !== row);
    text = documentText(job, rendered, { window });
  }
  const bodyBytes = Buffer.byteLength(documentText(job, rendered, { window, excerpts: [] }), "utf8") - Buffer.byteLength(renderExcerpts([]), "utf8");
  const references = compactionHeaderItems(header).flatMap(item => [...item.sources, ...("supersedes" in item ? item.supersedes ?? [] : [])]).filter((source): source is string => typeof source === "string");
  const preservedIds = references.flatMap(source => /^\[excerpt:([A-Za-z0-9_-]+)\]$/.exec(source)?.[1] ?? []);
  const selection = fitExcerpts(job.excerpts, { targetBytes: Math.max(0, targetBytes - bodyBytes), preservedIds });
  text = documentText(job, rendered, { window, excerpts: selection.excerpts });
  const bytes = Buffer.byteLength(text, "utf8");
  return { cutId: job.cutId, text, bytes, targetBytes, overflowBytes: Math.max(0, bytes - targetBytes), omittedSummaryIds, omittedExcerptIds: selection.omittedIds,
    headerWords: rendered.split(/\s+/).filter(Boolean).length, headerWordTarget: HEADER_WORD_TARGET };
}
