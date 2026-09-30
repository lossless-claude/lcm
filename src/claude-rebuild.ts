import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { compareStoredMessageContent, normalizeMessageContent } from "./message-content.js";
import { REDACTION_MARKER } from "./scrub.js";
import { ConversationStore } from "./store/conversation-store.js";
import { CLAUDE_PARSER_SHAPE, TOOL_ERROR_MARKER, type ParsedMessage } from "./transcript.js";

/**
 * Rebuilding a Claude Code session from its transcript. Before compaction stopped counting
 * its own event rows, a capture after a compaction skipped as many transcript messages as the
 * session held event rows, and the first capture after the fix stored the last ones again. A
 * rebuild replaces the session's stored history with its transcript, captured from the start;
 * it keeps the conversation row, its large files, and promoted memory.
 *
 * Compacted sessions and sessions with an unknown parser shape can carry that damage. The
 * classification here is read-only: the dry run uses it on a read-only connection, and the
 * daemon repeats it inside the rebuild's transaction before changing anything.
 */

/**
 * - `aligned`: stored history is a prefix of the transcript (an uncaptured tail is backlog).
 * - `repairable`: it is not, but the transcript holds every stored message, so a rebuild loses nothing.
 * - `unavailable`: no transcript to rebuild from.
 * - `ambiguous`: a rebuild would lose stored content, or the history cannot be compared; report only.
 */
export type RebuildKind = "aligned" | "repairable" | "unavailable" | "ambiguous";

export interface SessionRebuildPlan {
  sessionId: string;
  kind: RebuildKind;
  /** Why the session is ambiguous or unavailable. */
  reason?: string;
  /** The conversation a rebuild replaces; absent when there is not exactly one. */
  conversationId?: number;
  /** Transcript messages before the last stored one that stored history lacks. */
  gaps: number;
  /** Stored messages the in-order alignment could not place, such as a repeated tail. */
  extras: number;
  /** Summaries a rebuild discards. */
  leafSummaries: number;
  condensedSummaries: number;
}

/** Older read-only databases have no Claude marker; their cursors still identify Codex/OMP. */
function otherClientCursor(db: DatabaseSync): string {
  const columns = db.prepare("PRAGMA table_info(codex_ingest_cursors)").all() as Array<{ name: string }>;
  return columns.some(column => column.name === "claude_redaction_key") ? " AND k.claude_redaction_key IS NULL" : "";
}

/**
 * Sessions whose conversations hold at least one compaction event row, excluding sessions a
 * transcript cursor reads (Codex and OMP), which recover by their own rules.
 */
export function compactedSessionIds(db: DatabaseSync): string[] {
  const hasCursors = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'codex_ingest_cursors'").get();
  const rows = db.prepare(
    `SELECT DISTINCT c.session_id FROM conversations c
     JOIN messages m ON m.conversation_id = c.conversation_id
     JOIN message_parts p ON p.message_id = m.message_id AND p.part_type = 'compaction'
     ${hasCursors ? `WHERE NOT EXISTS (SELECT 1 FROM codex_ingest_cursors k JOIN conversations kc ON kc.conversation_id = k.conversation_id WHERE kc.session_id = c.session_id${otherClientCursor(db)})` : ""}
     ORDER BY c.session_id`,
  ).all() as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/** Compacted sessions and count-based sessions whose parser shape needs verification or repair. */
export function claudeRebuildCandidateIds(db: DatabaseSync): string[] {
  const ids = new Set(compactedSessionIds(db));
  const hasCursors = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'codex_ingest_cursors'").get();
  // The dry run reads a database the daemon may not have migrated yet: without the column,
  // no conversation has a known shape.
  const hasShape = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>)
    .some((column) => column.name === "parser_shape");
  const conditions = [
    ...(hasShape ? ["(c.parser_shape IS NULL OR c.parser_shape <> ?)"] : []),
    ...(hasCursors ? [`NOT EXISTS (SELECT 1 FROM codex_ingest_cursors k JOIN conversations kc ON kc.conversation_id = k.conversation_id WHERE kc.session_id = c.session_id${otherClientCursor(db)})`] : []),
  ];
  const rows = db.prepare(
    `SELECT DISTINCT c.session_id FROM conversations c${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`,
  ).all(...(hasShape ? [CLAUDE_PARSER_SHAPE] : [])) as Array<{ session_id: string }>;
  for (const row of rows) ids.add(row.session_id);
  return [...ids].sort();
}

/**
 * Aligns the session's stored transcript messages (compaction's event rows excluded, oldest
 * conversation first) with the parsed transcript, in order, comparing role and content under
 * the current redaction rules on both sides — the comparison the capture guard makes.
 * `transcript` is undefined when there is no transcript file. `legacyTranscript` yields the
 * transcript in the pre-#406 tool-content shape; it is read only when the session is not
 * aligned, or was captured before role tagging.
 */
export async function planSessionRebuild(
  db: DatabaseSync, sessionId: string, transcript: ParsedMessage[] | undefined, scrub: (text: string) => string,
  legacyTranscript?: () => ParsedMessage[] | undefined,
): Promise<SessionRebuildPlan> {
  const conversations = db.prepare("SELECT conversation_id, role_tagging FROM conversations WHERE session_id = ?")
    .all(sessionId) as Array<{ conversation_id: number; role_tagging: string | null }>;
  const conversationId = conversations.length === 1 ? conversations[0].conversation_id : undefined;
  const summaries = conversationId === undefined ? [] : db.prepare(
    "SELECT kind, COUNT(*) AS n FROM summaries WHERE conversation_id = ? GROUP BY kind",
  ).all(conversationId) as Array<{ kind: string; n: number }>;
  const base = {
    sessionId, conversationId, gaps: 0, extras: 0,
    leafSummaries: summaries.find((row) => row.kind === "leaf")?.n ?? 0,
    condensedSummaries: summaries.find((row) => row.kind === "condensed")?.n ?? 0,
  };
  if (!transcript) return { ...base, kind: "unavailable", reason: "no transcript file" };
  if (conversationId === undefined) return { ...base, kind: "ambiguous", reason: `${conversations.length} conversations` };
  const untagged = conversations[0].role_tagging === null;

  const key = (role: string, content: string) => `${role}\u0000${normalizeMessageContent(scrub(content))}`;
  const have = (await new ConversationStore(db).getSessionMessages(sessionId)).map((m) => key(m.role, m.content));
  const currentKeys = transcript.map((m) => key(m.role, m.content));
  const current = searchable(transcript);
  const { gaps, extras, cuts } = align(have, currentKeys, current, scrub);
  if (!untagged && gaps === 0 && extras === 0 && cuts === 0) return { ...base, kind: "aligned" };
  const legacy = searchable(legacyTranscript?.() ?? []);
  const legacyKeys = legacy.messages.map((m) => key(m.role, m.content));
  const content = (key: string) => key.slice(key.indexOf("\u0000") + 1);
  // An untagged session that has not grown is exactly its pre-role-tagging parse: capture never
  // needs to slice it again, so rebuilding it would only discard its summaries. The legacy parse
  // drops a tool-call-only entry, so growth by one shows only in today's parse: its last row must
  // be the last legacy row (error markers aside), not a tool-call row appended after it.
  const withoutMarkers = (text: string) => text.split(`${TOOL_ERROR_MARKER}\n`).join("");
  const lastCurrent = currentKeys.at(-1);
  const lastLegacy = legacyKeys.at(-1);
  const grownPastLegacy = lastCurrent === undefined ? false
    : lastLegacy === undefined || withoutMarkers(content(lastCurrent)) !== content(lastLegacy);
  if (untagged && !grownPastLegacy && have.length === legacyKeys.length &&
      have.every((stored, index) => content(stored) === content(legacyKeys[index]))) {
    return { ...base, kind: "aligned" };
  }
  const present = new Set((untagged ? [...currentKeys, ...legacyKeys].map(content) : [...currentKeys, ...legacyKeys]));
  const lost = have.filter((stored) => !present.has(untagged ? content(stored) : stored) &&
    approximateMatch(stored, current, 0, transcript.length, scrub, untagged) === undefined &&
    approximateMatch(stored, legacy, 0, legacy.messages.length, scrub, untagged) === undefined).length;
  if (lost > 0) return { ...base, gaps, extras, kind: "ambiguous", reason: `${lost} stored messages are not in the transcript` };
  return { ...base, gaps, extras, kind: "repairable" };
}

/**
 * Greedy in-order alignment of stored message keys with transcript keys: each stored message
 * takes the next equal transcript message, so stored history has no gaps and no extras exactly
 * when it is a prefix of the transcript; the transcript messages it passes over are gaps, and a
 * stored message with none left to take is an extra. Earlier legacy cut or redacted matches
 * take precedence over a later exact match, preserving transcript order.
 */
function align(
  have: string[], want: string[], messages: Searchable, scrub: (text: string) => string,
): { gaps: number; extras: number; cuts: number } {
  const positions = new Map<string, Candidates>();
  want.forEach((k, index) => {
    const entry = positions.get(k);
    if (entry) entry.indices.push(index);
    else positions.set(k, { indices: [index], next: 0 });
  });
  let cursor = 0;
  let gaps = 0;
  let extras = 0;
  let cuts = 0;
  for (const k of have) {
    const candidates = positions.get(k);
    const exact = candidates && nextCandidate(candidates, cursor);
    const approximate = approximateMatch(k, messages, cursor, exact ?? want.length, scrub);
    const at = approximate?.index ?? exact;
    if (at !== undefined) {
      gaps += at - cursor;
      cursor = at + 1;
      if (approximate?.kind === "cut") cuts++;
      continue;
    }
    extras++;
  }
  return { gaps, extras, cuts };
}

/** One key's transcript positions, and the first of them not yet passed. */
interface Candidates {
  indices: number[];
  next: number;
}

/** The first candidate at or after the cursor. The cursor only moves forward, so `next` does too. */
function nextCandidate(candidates: Candidates, cursor: number): number | undefined {
  while (candidates.next < candidates.indices.length && candidates.indices[candidates.next] < cursor) candidates.next++;
  return candidates.indices[candidates.next];
}

/** A transcript's messages, with the positions of those holding a NUL found once. */
interface Searchable {
  messages: ParsedMessage[];
  nul: number[];
}

function searchable(messages: ParsedMessage[]): Searchable {
  return { messages, nul: messages.flatMap((m, index) => (m.content.includes("\u0000") ? [index] : [])) };
}

/** Search only before an exact match, preserving the earliest in-order match for legacy cut rows. */
function approximateMatch(
  k: string, { messages, nul }: Searchable, from: number, until: number, scrub: (text: string) => string,
  ignoreRole = false,
): { index: number; kind: "full" | "cut" } | undefined {
  const role = k.slice(0, k.indexOf("\u0000") + 1);
  const content = k.slice(role.length);
  // Keys already compare normalized text exactly; only a redacted stored row or a transcript
  // message holding a NUL can match any other way, so only those positions are compared.
  const positions = content.includes(REDACTION_MARKER)
    ? Array.from({ length: Math.max(0, until - from) }, (_, offset) => from + offset)
    : nul.slice(lowerBound(nul, from), lowerBound(nul, until));
  for (const index of positions) {
    if (!ignoreRole && `${messages[index].role}\u0000` !== role) continue;
    const kind = compareStoredMessageContent(content, messages[index].content, scrub);
    if (kind) return { index, kind };
  }
  return undefined;
}

/** The first position in a sorted list not below `value`. */
function lowerBound(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Deletes a conversation's summaries, context items, messages (their parts cascade) and their
 * full-text rows, and every replay-ledger row of its session, so a later `--replay`
 * summarises it again. Keeps the conversation row, its large files and promoted memory.
 * Runs inside the caller's transaction and opens none: a failure, including a full-text
 * delete or a summary of another conversation still citing one of these messages, throws
 * and the caller's rollback leaves everything as it was.
 */
export function clearConversationForRebuild(db: DatabaseSync, conversationId: number, sessionId: string): void {
  const summaryIds = "SELECT summary_id FROM summaries WHERE conversation_id = ?";
  const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  if (hasTable("summaries_fts")) db.prepare(`DELETE FROM summaries_fts WHERE summary_id IN (${summaryIds})`).run(conversationId);
  if (hasTable("messages_fts")) {
    db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT message_id FROM messages WHERE conversation_id = ?)").run(conversationId);
  }
  // context_items and summary_messages restrict deleting what they cite, so they go first.
  db.prepare("DELETE FROM context_items WHERE conversation_id = ?").run(conversationId);
  db.prepare(`DELETE FROM summary_messages WHERE summary_id IN (${summaryIds})`).run(conversationId);
  db.prepare(`DELETE FROM summary_parents WHERE summary_id IN (${summaryIds})`).run(conversationId);
  db.prepare("DELETE FROM summaries WHERE conversation_id = ?").run(conversationId);
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  db.prepare("DELETE FROM replay_ledger WHERE session_id = ?").run(sessionId);
}

/**
 * A consistent copy of the project database, write-ahead log included, next to it:
 * `<db>.bak-rebuild-<timestamp>`. The caller holds the project's mutation lease through
 * the backup, so no daemon write can interleave with its steps. External writers make
 * SQLite's backup restart; either way, the finished copy is consistent.
 */
export async function backupProjectDatabase(db: DatabaseSync, dbPath: string, now: Date = new Date(), onRemoved?: (path: string) => void): Promise<string> {
  const target = `${dbPath}.bak-rebuild-${now.toISOString().replace(/[:.]/g, "-")}`;
  if (existsSync(target)) throw new Error("output file already exists");
  if (typeof sqlite.backup === "function") {
    // Common 4 KiB pages make each 16-page step about 64 KiB of synchronous work.
    await sqlite.backup(db, target, { rate: 16 });
  } else {
    // node:sqlite added backup() in Node 22.16; package.json also supports older 22.x.
    db.prepare("VACUUM INTO ?").run(target);
  }
  // Only once the new copy is complete: keep it and the oldest copy, the database as it was
  // before any rebuild, and remove the ones in between. Timestamped names sort oldest first.
  const prefix = `${basename(dbPath)}.bak-rebuild-`;
  const older = readdirSync(dirname(dbPath), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name !== basename(target))
    .map((entry) => entry.name)
    .sort();
  for (const name of older.slice(1)) {
    const path = join(dirname(dbPath), name);
    rmSync(path);
    onRemoved?.(path);
  }
  return target;
}
