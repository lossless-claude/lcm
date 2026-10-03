import { COMPACTION_HEADER_SECTIONS, type CompactionHeader, type CompactionHeaderItem, type HeaderSource } from "./compaction-header-schema.js";

export type CitationEvidence = { cutId: string; originals: readonly { id: number; text: string }[]; excerpts: readonly { id: string; rawMessageId: number }[]; summaries: readonly string[] };
export type CitationStatus = "resolved" | "missing" | "ambiguous";
export type CitationCheck = { field: "sources" | "supersedes"; index: number; source: HeaderSource; status: CitationStatus; originalIds: number[] };
export type ItemCitations = { section: typeof COMPACTION_HEADER_SECTIONS[number]; item: number; status: CitationStatus; citations: CitationCheck[] };
export type HeaderCitations = { version: 1; items: ItemCitations[] };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** The live path uses this predicate; absent, missing or ambiguous evidence refuses. */
export function allCitationsResolved(value: HeaderCitations | null | undefined): boolean {
  return value?.version === 1 && value.items.every(item => item.status === "resolved" && item.citations.every(citation => citation.status === "resolved"));
}
export function resolveHeaderCitations(header: CompactionHeader, evidence?: CitationEvidence): HeaderCitations {
  return { version: 1, items: COMPACTION_HEADER_SECTIONS.flatMap(section => header[section].map((item, index) => resolveItem({ section, item: index }, item, evidence))) };
}
function resolveItem(address: Pick<ItemCitations, "section" | "item">, item: CompactionHeaderItem, evidence?: CitationEvidence): ItemCitations {
  const citations = item.sources.map((source, index) => resolveCitation({ source, field: "sources", index }, evidence));
  if ("supersedes" in item) citations.push(...(item.supersedes ?? []).map((source, index) => resolveCitation({ source, field: "supersedes", index }, evidence)));
  const status = itemStatus(citations);
  return { ...address, status, citations };
}
function itemStatus(citations: readonly CitationCheck[]): CitationStatus {
  if (citations.some(citation => citation.status === "ambiguous")) return "ambiguous";
  return citations.every(citation => citation.status === "resolved") ? "resolved" : "missing";
}
function resolveCitation(citation: Pick<CitationCheck, "source" | "field" | "index">, evidence?: CitationEvidence): CitationCheck {
  if (!evidence) return { ...citation, status: "missing", originalIds: [] };
  const { source } = citation;
  if (typeof source !== "string") return matchResult(citation, source.quote ? evidence.originals.filter(row => row.text.includes(source.quote)).map(row => row.id) : []);
  const raw = /^\[raw:([A-Za-z0-9_-]+):([1-9]\d*)\]$/.exec(source);
  if (raw) return matchResult(citation, raw[1] === evidence.cutId ? evidence.originals.filter(row => row.id === Number(raw[2])).map(row => row.id) : []);
  return resolveNamed(citation, evidence);
}
function resolveNamed(citation: Pick<CitationCheck, "source" | "field" | "index">, evidence: CitationEvidence): CitationCheck {
  const source = citation.source as string;
  const excerpt = /^\[excerpt:([A-Za-z0-9_-]+)\]$/.exec(source);
  if (excerpt) {
    const rows = evidence.excerpts.filter(row => row.id === excerpt[1]);
    return matchResult(citation, rows.flatMap(row => evidence.originals.filter(original => original.id === row.rawMessageId).map(original => original.id)));
  }
  const summary = /^\[sum:(sum_[A-Za-z0-9_-]+)\]$/.exec(source);
  const count = summary ? evidence.summaries.filter(id => id === summary[1]).length : 0;
  return { ...citation, status: matchStatus(count), originalIds: [] };
}
function matchResult(citation: Pick<CitationCheck, "source" | "field" | "index">, ids: number[]): CitationCheck {
  return { ...citation, status: matchStatus(ids.length), originalIds: ids };
}
function matchStatus(count: number): CitationStatus { return count === 1 ? "resolved" : count === 0 ? "missing" : "ambiguous"; }
/** Copy before calling a model; a later cut cannot mutate this resolution index. */
export function freezeCitationEvidence(value?: CitationEvidence): CitationEvidence | undefined {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as CitationEvidence;
}
