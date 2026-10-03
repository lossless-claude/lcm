import { HEADER_SECTIONS, type StoredShadowHeader, type ShadowOriginal } from "../../daemon/shadow/types.js";
import { compactionHeaderItems, type HeaderSource } from "../../../hooks/compaction-header-schema.js";
import { assembleExcerpts, checkExcerpts, type UserExcerpt } from "../../compaction-header/excerpts.js";
import { renderWorkingHeader } from "../../daemon/shadow/header-job.js";

const identifiers = (text: string): string[] => [...new Set([
  ...(text.match(/\bsum_[A-Za-z0-9_-]+\b/g) ?? []), ...(text.match(/#[1-9]\d*/g) ?? []),
  ...(text.match(/(?:\.?\/)?[A-Za-z0-9_@/-]+(?:\.[A-Za-z0-9_-]+)+/g) ?? []).map(token => token.replace(/\.$/, "")),
  ...(text.match(/\b(?:npm|pnpm|yarn)\s+(?:(?:run|exec)\s+[A-Za-z0-9_./:-]+|[A-Za-z0-9_./:-]+)|\b(?:git|node|lcm|pytest|cargo|go)\s+[A-Za-z0-9_./:-]+/g) ?? []),
  ...(text.match(/\b(?:[a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*|[A-Z][a-z]+[A-Z][A-Za-z0-9_$]*)\b|\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []),
  ...[...text.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(token => /^(?:npm|pnpm|yarn|git|node|lcm|pytest|cargo|go|bash|sh|python3?|rg|curl|ssh|rm|cp|mv|mkdir)\s/.test(token)),
  ...[...text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$.:]*)`/g)].map(match => match[1]),
].map(token => token.replace(/\.$/, "")))];
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function present(identifier: string, text: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_./-])${escaped(identifier)}(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9_])`).test(text);
}
type Evidence = { originals: readonly ShadowOriginal[]; cutId: string; summaries: ReadonlyMap<string, readonly number[]>; excerpts?: readonly UserExcerpt[] };
function pointerValid(source: string | { quote: string }, evidence: Evidence): boolean {
  if (typeof source !== "string") return Boolean(source.quote) && evidence.originals.filter(row => row.text.includes(source.quote)).length === 1;
  const excerpt = /^\[excerpt:([A-Za-z0-9_-]+)\]$/.exec(source);
  if (excerpt) return Boolean(evidence.excerpts?.some(row => row.id === excerpt[1] && evidence.originals.some(original => original.id === row.rawMessageId)));
  const raw = source.match(/^\[raw:([A-Za-z0-9_-]+):(\d+)\]$/);
  if (raw) return raw[1] === evidence.cutId && evidence.originals.some(row => row.id === Number(raw[2]));
  const sum = source.match(/^\[sum:(sum_[A-Za-z0-9_-]+)\]$/);
  if (!sum) return false;
  const ids = evidence.summaries.get(sum[1]);
  return Boolean(ids?.length) && ids!.every(id => evidence.originals.some(row => row.id === id));
}
type ClaimItem = { text?: string; sources: HeaderSource[]; status?: string; fix?: string; supersedes?: HeaderSource[] };
function itemClaims(item: ClaimItem): string {
  const sourceIds = item.sources.filter((source): source is string => typeof source === "string" && /^\[sum:/.test(source));
  return [item.text, item.status, item.fix, ...(item.supersedes ?? []).filter(value => typeof value === "string"), ...sourceIds].filter(value => typeof value === "string").join("\n");
}
export function checkFaithfulness(header: StoredShadowHeader, evidence: Evidence) {
  const originalText = evidence.originals.map(row => row.text).join("\n");
  const items: ClaimItem[] = header.version === 1 ? HEADER_SECTIONS.flatMap(section => header[section]) : compactionHeaderItems(header);
  const excerpts = evidence.excerpts ?? assembleExcerpts(evidence.originals, evidence.cutId).excerpts;
  const proof = { ...evidence, excerpts };
  const named = items.flatMap(item => identifiers(itemClaims(item)));
  const unsupportedIdentifiers = [...new Set(named.filter(identifier => !present(identifier, originalText)))].sort();
  const unresolvedPointers = items.flatMap(item => [...item.sources, ...supersessionPointers(item)]).filter(source => !pointerValid(source, proof))
    .map(source => typeof source === "string" ? source : JSON.stringify(source));
  const users = evidence.originals.filter(row => row.origin === "user");
  const verbatimFailures = header.version === 1 ? header.directives.filter(item => !users.some(row => row.text.includes(item.text))).length
    : checkExcerpts(excerpts, evidence.originals, evidence.cutId).length;
  return { unsupportedIdentifiers, unresolvedPointers, verbatimFailures };
}
function supersessionPointers(item: ClaimItem): HeaderSource[] {
  return (item.supersedes ?? []).filter(source => typeof source !== "string" || source.startsWith("["));
}
export function renderHeader(header: StoredShadowHeader): string {
  if (header.version === 2) return renderWorkingHeader(header);
  return HEADER_SECTIONS.map(key => `${key}:\n${header[key].map(item => [item.text,
    item.status ? `Status: ${item.status}` : "", item.fix ? `Fix: ${item.fix}` : "", item.supersedes?.length ? `Supersedes: ${item.supersedes.join(", ")}` : "",
    item.sources.map(source => typeof source === "string" ? source : JSON.stringify(source)).join(" ")].filter(Boolean).join("\n")).join("\n")}`).join("\n\n");
}
