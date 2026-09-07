import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RetrievalEngine } from "../retrieval.js";
import { ConversationStore, type MessageSearchResult } from "../store/conversation-store.js";
import { SummaryStore, type SummarySearchResult } from "../store/summary-store.js";
import { prepareFts5Query } from "../store/fts5-query.js";

const MAX_SNIPPET_CHARS = 1000;
type HistoryHit = MessageSearchResult | SummarySearchResult;
type SourceContext = {
  snippet: string;
  span: { start: number; end: number };
  sourceHash: string;
  snippetTruncated: boolean;
};
export type NativeHistoryHit = HistoryHit & SourceContext;

function anchorSpan(content: string, hint: string): { start: number; length: number } {
  const fragments = hint.split("...").map(part => part.trim()).filter(Boolean);
  fragments.sort((a, b) => b.length - a.length);
  for (const fragment of fragments) {
    const start = content.indexOf(fragment);
    if (start >= 0) return { start, length: fragment.length };
  }
  return { start: 0, length: 0 };
}

function matchedAnchor(db: DatabaseSync, hit: HistoryHit, query: string, content: string) {
  const prepared = prepareFts5Query(query);
  if (!prepared) return anchorSpan(content, hit.snippet);
  const marker = randomUUID();
  const open = `<${marker}>`;
  const close = `</${marker}>`;
  const message = "messageId" in hit;
  const table = message ? "messages_fts" : "summaries_fts";
  const key = message ? "rowid" : "summary_id";
  try {
    const row = db.prepare(`SELECT snippet(${table}, ${message ? 0 : 1}, ?, ?, '...', 32) AS marked
      FROM ${table} WHERE ${table} MATCH ? AND ${key} = ?`)
      .get(open, close, prepared.or, message ? hit.messageId : hit.summaryId) as { marked: string } | undefined;
    if (row) return markedSpan(content, row.marked, open, close) ?? anchorSpan(content, hit.snippet);
  } catch {
    // The existing LIKE fallback also works on runtimes without FTS5.
  }
  return anchorSpan(content, hit.snippet);
}

function markedSpan(content: string, hint: string, open: string, close: string) {
  const strip = (text: string) => text.replaceAll(open, "").replaceAll(close, "");
  const fragments = hint.split("...").sort((a, b) => b.split(open).length - a.split(open).length);
  for (const fragment of fragments) {
    const first = fragment.indexOf(open);
    const last = fragment.lastIndexOf(close);
    const sourceStart = content.indexOf(strip(fragment));
    if (first < 0 || last < first || sourceStart < 0) continue;
    let length = strip(fragment.slice(first + open.length, last)).length;
    if (length > MAX_SNIPPET_CHARS) length = fragment.indexOf(close, first) - first - open.length;
    return { start: sourceStart + strip(fragment.slice(0, first)).length, length };
  }
  return null;
}

function sourceContext(content: string, anchor: { start: number; length: number }): SourceContext {
  const padding = Math.max(0, Math.floor((MAX_SNIPPET_CHARS - anchor.length) / 2));
  let start = Math.max(0, Math.min(anchor.start - padding, content.length - MAX_SNIPPET_CHARS));
  let end = Math.min(content.length, start + MAX_SNIPPET_CHARS);
  // Spans use UTF-16 positions; never split an astral character at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start])) start++;
  if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  return {
    snippet: content.slice(start, end), span: { start, end },
    sourceHash: createHash("sha256").update(content).digest("hex"),
    snippetTruncated: start > 0 || end < content.length,
  };
}

/** Read one request's ranked history and bounded source context on its own DB connection. */
export async function searchNativeHistory(
  db: DatabaseSync,
  input: { query: string; limit: number },
): Promise<NativeHistoryHit[]> {
  const messages = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  const engine = new RetrievalEngine(messages, summaries);
  db.exec("SAVEPOINT native_history_read");
  try {
    const result = await engine.grep({ query: input.query, mode: "full_text", scope: "both" });
    const selected = [...result.messages, ...result.summaries].slice(0, input.limit);
    const matches: NativeHistoryHit[] = [];
    for (const hit of selected) {
      const source = "messageId" in hit
        ? await messages.getMessageById(hit.messageId)
        : await summaries.getSummary(hit.summaryId);
      if (source) matches.push({ ...hit, ...sourceContext(source.content, matchedAnchor(db, hit, input.query, source.content)) });
    }
    return matches;
  } finally {
    db.exec("RELEASE native_history_read");
  }
}
