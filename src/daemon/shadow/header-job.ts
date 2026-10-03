import { COMPACTION_HEADER_SECTIONS, validCompactionHeader, type CompactionHeader, type HeaderSource } from "../../../hooks/compaction-header-schema.js";
import { assembleExcerpts, checkExcerpts, renderExcerpts, type UserExcerpt } from "../../compaction-header/excerpts.js";
import { renderTemplate } from "../../prompts/loader.js";
import { fenceContent } from "../content-fence.js";
import { verifyNativeTail } from "./tail.js";
import { objectHash } from "./types.js";
import type { ContextWindowItem } from "../../store/summary-store.js";
import type { ShadowMessage, ShadowOriginal } from "./types.js";
import type { CitationEvidence } from "../../../hooks/header-citations.js";

export type HeaderJobInput = { cutId: string; instructions: string; originals: readonly ShadowOriginal[]; window: readonly ContextWindowItem[]; tail: readonly ShadowMessage[]; engineMessages: readonly ShadowMessage[] };
export const HEADER_WORD_TARGET = 750;
export const DOCUMENT_BYTE_TARGET = 65_536;
export type PreparedHeaderJob = {
  version: 1; cutId: string; excerpts: UserExcerpt[]; window: ContextWindowItem[]; tail: ShadowMessage[];
  forkPrompt: string; completePrompt: string; promptHash: string; forkPromptHash: string; inputHash: string;
  elidedExcerptIds: number[];
  evidence: CitationEvidence;
};
export function prepareHeaderJob(input: HeaderJobInput, { messageTargetBytes = 4096 } = {}): PreparedHeaderJob {
  verifyNativeTail(input.tail, input.engineMessages, text => text);
  const selection = assembleExcerpts(input.originals, input.cutId, { messageTargetBytes });
  if (checkExcerpts(selection.excerpts, input.originals, input.cutId).length) throw new Error("Non-verbatim excerpt");
  const window = input.window.map(row => ({ ...row })).sort((a, b) => a.ordinal - b.ordinal);
  const tail = input.tail.map(row => ({ ...row }));
  const shared = { instructions: sourceBlock(input.instructions), excerpts: selection.excerpts.map(row => ({ id: row.id, rawMessageId: row.rawMessageId,
    sources: row.sources, pointer: `[excerpt:${row.id}]`, text: sourceBlock(row.text) })) };
  const evidence = { ...shared, window: renderWindow(window, input.cutId), tail: tail.map(row => ({ ...row, text: sourceBlock(row.text) })) };
  const completePrompt = prompt(evidence), forkPrompt = prompt({ ...shared, transcript: "Use your existing fork prefix; no digested window is supplied." });
  return { version: 1, cutId: input.cutId, excerpts: selection.excerpts, window, tail, completePrompt, forkPrompt,
    inputHash: objectHash(evidence), promptHash: objectHash(completePrompt), forkPromptHash: objectHash(forkPrompt),
    elidedExcerptIds: selection.elidedIds, evidence: headerCitationEvidence(input.cutId, input.originals, input.window) };
}
export function headerCitationEvidence(cutId: string, originals: readonly ShadowOriginal[], window: readonly ContextWindowItem[]): CitationEvidence {
  return { cutId, originals: originals.map(row => ({ id: row.id, text: row.text })), excerpts: assembleExcerpts(originals, cutId).excerpts.map(row => ({ id: row.id, rawMessageId: row.rawMessageId })),
    summaries: window.filter(row => row.itemType === "summary").map(row => row.summaryId!) };
}
function prompt(evidence: unknown): string {
  return renderTemplate("compaction-header", { word_target: String(HEADER_WORD_TARGET), evidence: fenceContent(JSON.stringify(evidence), "compaction-evidence") });
}
function renderWindow(window: readonly ContextWindowItem[], cutId: string): string {
  return window.map(row => row.itemType === "summary" ? `[sum:${row.summaryId}]\n${sourceBlock(row.content)}`
    : `[raw:${cutId}:${row.messageId}] ${row.role}:\n${sourceBlock(row.content)}`).join("\n\n");
}
function sourceBlock(text: string): string {
  return fenceContent(text, "compaction-source");
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
  return [renderExcerpts(excerpts, sourceBlock), header, `## Window\n${renderWindow(window, job.cutId)}`,
    `## Engine tail\n${job.tail.map(row => `${row.role}:\n${sourceBlock(row.text)}`).join("\n\n")}`].join("\n\n");
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
  const bytes = Buffer.byteLength(text, "utf8");
  return { cutId: job.cutId, text, bytes, targetBytes, overflowBytes: Math.max(0, bytes - targetBytes), omittedSummaryIds, elidedExcerptIds: job.elidedExcerptIds,
    headerWords: rendered.split(/\s+/).filter(Boolean).length, headerWordTarget: HEADER_WORD_TARGET };
}
