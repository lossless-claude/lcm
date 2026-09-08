import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RetrievalEngine } from "../retrieval.js";
import { ConversationStore, type MessageSearchResult } from "../store/conversation-store.js";
import { SummaryStore, type SummarySearchResult } from "../store/summary-store.js";
import { prepareFts5Query } from "../store/fts5-query.js";

const MAX_SNIPPET_CHARS = 1000;
/** Reciprocal-rank offset: small enough that a top position still outweighs one corroborating source further down. */
const FUSION_RANK_OFFSET = 10;
type HistoryHit = MessageSearchResult | SummarySearchResult;
export type RankedHistoryHit = HistoryHit & { sessionId: string | null };
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

/**
 * Share of the limit held for summaries before messages may take a slot.
 *
 * Message and summary ranks come from different FTS5 tables, so their bm25
 * scores are not comparable and the two sources cannot be merged by score.
 * Without a reserved share the round-robin below emits one message per
 * matching session and exhausts the limit on its first pass, which makes a
 * summary unreachable whenever the session count reaches the limit — however
 * well it scores. Reserving is skipped at limit 1, where a single slot is
 * better spent on the source the caller already expects.
 */
const SUMMARY_LIMIT_SHARE = 1 / 3;

/** Round-robin over sessions in RRF order, one hit per session per pass. */
function drawBySession(
  hits: RankedHistoryHit[],
  groups: string[],
  groupOf: (hit: RankedHistoryHit) => string,
  budget: number,
): RankedHistoryHit[] {
  const hitsOf = new Map<string, RankedHistoryHit[]>(groups.map(group => [group, []]));
  for (const hit of hits) hitsOf.get(groupOf(hit))?.push(hit);
  const drawn: RankedHistoryHit[] = [];
  for (let pass = 0; drawn.length < budget; pass++) {
    let emitted = false;
    for (const group of groups) {
      const hit = hitsOf.get(group)![pass];
      if (!hit || drawn.length >= budget) continue;
      drawn.push(hit);
      emitted = true;
    }
    if (!emitted) break;
  }
  return drawn;
}

/**
 * Length-normalisation strength, in the role BM25's `b` plays for message
 * length. 0 leaves scores untouched, 1 divides by the size ratio outright.
 *
 * Chosen on five corpora (171 questions) and graded once on four it had never
 * seen (197): 0.269 to 0.320, +13 questions against -3. The curve is a broad
 * plateau — every value from 0.25 to 0.75 beats no normalisation at all — so
 * this sits at its centre rather than on a peak.
 */
const SESSION_LENGTH_NORM = 0.4;

/**
 * Damp a session's score by how large the session is, the way bm25 already
 * damps a message's score by how long the message is.
 *
 * A session scores the reciprocal rank of the *best* position any one of its
 * rows reached. A long session enters the candidate pool many times, so one of
 * its rows lands high on almost any query — measured, a single 368 KB session
 * took 11 of 13 top-5 slots on unrelated questions. Nothing below the row level
 * corrected for that.
 *
 * `sizeOf` returning undefined leaves that session unnormalised, so a session
 * whose size cannot be established is neither rewarded nor punished for it.
 */
function normaliseBySessionSize(score: Map<string, number>, sizeOf: (group: string) => number | undefined): void {
  const sizes = [...score.keys()].map(sizeOf).filter((size): size is number => size !== undefined && size > 0);
  if (sizes.length === 0) return;
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  if (average <= 0) return;
  for (const [group, value] of score) {
    const size = sizeOf(group);
    if (size === undefined || size <= 0) continue;
    score.set(group, value / (1 - SESSION_LENGTH_NORM + SESSION_LENGTH_NORM * (size / average)));
  }
}

/**
 * Fuse message and summary candidates by session: a session scores the sum of
 * reciprocal ranks of its best message and best summary, so evidence present
 * in both sources rises, damped by how large the session is. Summaries draw
 * first against a reserved share of the limit, messages take the rest, and
 * whichever side underfills hands its leftover to the other. Emission stays
 * round-robin, one hit per session per pass, so a small limit still spans
 * several sessions.
 */
export function fuseHistoryBySession(
  messages: RankedHistoryHit[],
  summaries: RankedHistoryHit[],
  limit: number,
  sessionSize?: (group: string) => number | undefined,
): RankedHistoryHit[] {
  const groupOf = (hit: RankedHistoryHit) => hit.sessionId ?? `conversation:${hit.conversationId}`;
  const score = new Map<string, number>();
  for (const list of [messages, summaries]) {
    const seen = new Set<string>();
    list.forEach((hit, position) => {
      const group = groupOf(hit);
      if (seen.has(group)) return;
      seen.add(group);
      score.set(group, (score.get(group) ?? 0) + 1 / (FUSION_RANK_OFFSET + position));
    });
  }
  // Callers that cannot supply sizes keep the unnormalised order.
  if (sessionSize) normaliseBySessionSize(score, sessionSize);
  const groups = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([group]) => group);

  const reserved = limit >= 2 ? Math.ceil(limit * SUMMARY_LIMIT_SHARE) : 0;
  const drawnSummaries = drawBySession(summaries, groups, groupOf, reserved);
  const drawnMessages = drawBySession(messages, groups, groupOf, limit - drawnSummaries.length);
  // Messages that underfill hand the remainder back rather than shrinking the result.
  const extraSummaries = drawnMessages.length + drawnSummaries.length < limit
    ? drawBySession(summaries, groups, groupOf, limit - drawnMessages.length).slice(drawnSummaries.length)
    : [];

  const selected = new Set([...drawnSummaries, ...extraSummaries, ...drawnMessages]);
  // Re-emit in session order, a session's messages ahead of its summaries, so
  // the distilled hit sits next to the raw evidence it came from.
  const ordered = [...messages, ...summaries].filter(hit => selected.has(hit));
  return drawBySession(ordered, groups, groupOf, limit);
}

/** Rank one request's history candidates without loading source context. */
export async function rankNativeHistory(
  db: DatabaseSync,
  input: { query: string; limit: number },
): Promise<RankedHistoryHit[]> {
  return rankNativeHistorySync(db, input);
}

function rankNativeHistorySync(
  db: DatabaseSync,
  input: { query: string; limit: number },
): RankedHistoryHit[] {
  const messages = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  const engine = new RetrievalEngine(messages, summaries);
  const result = engine.grepSync({ query: input.query, mode: "full_text", scope: "both" });
  const sessionOf = new Map<number, string | null>();
  const attach = (hits: HistoryHit[]): RankedHistoryHit[] => {
    const ranked: RankedHistoryHit[] = [];
    for (const hit of hits) {
      if (!sessionOf.has(hit.conversationId)) {
        sessionOf.set(hit.conversationId, messages.getConversationSync(hit.conversationId)?.sessionId ?? null);
      }
      ranked.push({ ...hit, sessionId: sessionOf.get(hit.conversationId) ?? null });
    }
    return ranked;
  };
  return rankHistoryHits(attach(result.messages), attach(result.summaries), input.limit, sizes => sessionSizes(db, sizes, sessionOf));
}

/** Filter subagent transcripts out of the candidates, then fuse what remains. */
export function rankHistoryHits(
  messages: RankedHistoryHit[],
  summaries: RankedHistoryHit[],
  limit: number,
  sizesOf?: (hits: RankedHistoryHit[]) => (group: string) => number | undefined,
): RankedHistoryHit[] {
  const rankedMessages = withoutSubagents(messages);
  const rankedSummaries = withoutSubagents(summaries);
  const sizes = sizesOf?.([...rankedMessages, ...rankedSummaries]);
  return fuseHistoryBySession(rankedMessages, rankedSummaries, limit, sizes);
}

/**
 * Subagent transcripts, by the session id a transcript filename becomes.
 *
 * Claude Code writes a dispatched agent's transcript as `agent-<id>.jsonl`
 * beside the session's own, and ingestion takes the session id from the
 * filename. That naming is an external convention: if it ever changes, this
 * filter silently stops matching and search quietly gets noisier again.
 */
const SUBAGENT_SESSION = /^agent-/;

/**
 * Drop subagent transcripts from the ranked candidates.
 *
 * They are 78% of ingested sessions here — above 90% on some projects — and
 * they are not the user's memory: a review panel arguing about a diff, stored
 * as though the user had said it. Ranking searched a haystack that was mostly
 * machines talking to each other. Measured over 202 questions whose answers are
 * human sessions, dropping them gains 14 and loses **none** (0.337 to 0.406,
 * sign test p = 0.0001).
 *
 * They stay ingested and stay reachable: `lcm grep` and `lcm expand` go through
 * the retrieval engine directly and are untouched. What changes is only what
 * ranked recall offers up on its own.
 */
function withoutSubagents(hits: RankedHistoryHit[]): RankedHistoryHit[] {
  return hits.filter(hit => !(hit.sessionId && SUBAGENT_SESSION.test(hit.sessionId)));
}

/**
 * How many messages each candidate session holds, for the length normalisation.
 *
 * Counting rows in the candidate pool instead would be free, and was tried: it
 * loses on every question set. That signal is query-dependent — a session about
 * one subject fills the pool on queries about that subject, exactly when it is
 * the right answer, so it is damped hardest when it should win. The transcript
 * count does not move with the query. It costs one grouped count over the
 * conversations already in hand: 0.1 ms against a 500 ms budget.
 */
function sessionSizes(
  db: DatabaseSync,
  hits: RankedHistoryHit[],
  sessionOf: Map<number, string | null>,
): (group: string) => number | undefined {
  const conversations = [...new Set(hits.map(hit => hit.conversationId))];
  if (conversations.length === 0) return () => undefined;
  const rows = db.prepare(
    `SELECT conversation_id, COUNT(*) AS n FROM messages WHERE conversation_id IN (${conversations.map(() => "?").join(",")}) GROUP BY conversation_id`,
  ).all(...conversations) as Array<{ conversation_id: number; n: number }>;
  const bySession = new Map<string, number>();
  for (const row of rows) {
    const group = sessionOf.get(row.conversation_id) ?? `conversation:${row.conversation_id}`;
    bySession.set(group, (bySession.get(group) ?? 0) + row.n);
  }
  return (group: string) => bySession.get(group);
}

/** Read one request's ranked history and bounded source context inside a savepoint on the caller's connection. */
export async function searchNativeHistory(
  db: DatabaseSync,
  input: { query: string; limit: number },
): Promise<NativeHistoryHit[]> {
  const messages = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  // Every read below must remain synchronous until RELEASE so one pooled
  // connection cannot mix ranking and source context from different snapshots.
  db.exec("SAVEPOINT native_history_read");
  try {
    const selected = rankNativeHistorySync(db, input);
    const matches: NativeHistoryHit[] = [];
    for (const hit of selected) {
      const source = "messageId" in hit
        ? messages.getMessageByIdSync(hit.messageId)
        : summaries.getSummarySync(hit.summaryId);
      if (source) matches.push({ ...hit, ...sourceContext(source.content, matchedAnchor(db, hit, input.query, source.content)) });
    }
    return matches;
  } finally {
    db.exec("RELEASE native_history_read");
  }
}
