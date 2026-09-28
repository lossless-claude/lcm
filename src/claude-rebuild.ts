import type { DatabaseSync } from "node:sqlite";
import { REDACTION_MARKER, matchesUnderRedaction } from "./scrub.js";
import { ConversationStore } from "./store/conversation-store.js";
import type { ParsedMessage } from "./transcript.js";

/**
 * Rebuilding a Claude Code session from its transcript. Before compaction stopped counting
 * its own event rows, a capture after a compaction skipped as many transcript messages as the
 * session held event rows, and the first capture after the fix stored the last ones again. A
 * rebuild replaces the session's stored history with its transcript, captured from the start;
 * it keeps the conversation row, its large files, and promoted memory.
 *
 * Only a session compaction wrote into can carry that damage, so only those are selected. The
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
     ${hasCursors ? "WHERE NOT EXISTS (SELECT 1 FROM codex_ingest_cursors k JOIN conversations kc ON kc.conversation_id = k.conversation_id WHERE kc.session_id = c.session_id)" : ""}
     ORDER BY c.session_id`,
  ).all() as Array<{ session_id: string }>;
  return rows.map((row) => row.session_id);
}

/**
 * Aligns the session's stored transcript messages (compaction's event rows excluded, oldest
 * conversation first) with the parsed transcript, in order, comparing role and content under
 * the current redaction rules on both sides — the comparison the capture guard makes.
 * `transcript` is undefined when there is no transcript file.
 */
export async function planSessionRebuild(
  db: DatabaseSync, sessionId: string, transcript: ParsedMessage[] | undefined, scrub: (text: string) => string,
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
  if (conversations[0].role_tagging === null) {
    return { ...base, kind: "ambiguous", reason: "captured by an earlier transcript parser" };
  }

  const key = (role: string, content: string) => `${role}\u0000${scrub(content)}`;
  const have = (await new ConversationStore(db).getSessionMessages(sessionId)).map((m) => key(m.role, m.content));
  const { gaps, extras, lost } = align(have, transcript.map((m) => key(m.role, m.content)));
  if (gaps === 0 && extras === 0) return { ...base, kind: "aligned" };
  if (lost > 0) return { ...base, gaps, extras, kind: "ambiguous", reason: `${lost} stored messages are not in the transcript` };
  return { ...base, gaps, extras, kind: "repairable" };
}

/**
 * Greedy in-order alignment of stored message keys with transcript keys: each stored message
 * takes the next equal transcript message, so stored history has no gaps and no extras exactly
 * when it is a prefix of the transcript; the transcript messages it passes over are gaps, and a
 * stored message with none left to take is an extra. `lost` counts stored messages the
 * transcript does not hold anywhere, which a rebuild could not restore. A stored message with
 * no equal one falls back to the guard's allowance for spans a pattern since removed redacted.
 */
function align(have: string[], want: string[]): { gaps: number; extras: number; lost: number } {
  const positions = new Map<string, Candidates>();
  want.forEach((k, index) => {
    const entry = positions.get(k);
    if (entry) entry.indices.push(index);
    else positions.set(k, { indices: [index], next: 0 });
  });
  let cursor = 0;
  let gaps = 0;
  let extras = 0;
  let lost = 0;
  for (const k of have) {
    const candidates = positions.get(k);
    const at = (candidates && nextCandidate(candidates, cursor)) ?? redactedMatch(k, want, cursor);
    if (at !== undefined) {
      gaps += at - cursor;
      cursor = at + 1;
      continue;
    }
    extras++;
    // Nothing matched from the cursor on, so a redacted match anywhere lies before it.
    if (!candidates && redactedMatch(k, want, 0) === undefined) lost++;
  }
  return { gaps, extras, lost };
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

/** The first transcript key from `from` on with the stored key's role that its redacted content matches (`matchesUnderRedaction`). */
function redactedMatch(k: string, want: string[], from: number): number | undefined {
  if (!k.includes(REDACTION_MARKER)) return undefined;
  const role = k.slice(0, k.indexOf("\u0000") + 1);
  const content = k.slice(role.length);
  const index = want.findIndex((w, i) => i >= from && w.startsWith(role) && matchesUnderRedaction(content, w.slice(role.length)));
  return index === -1 ? undefined : index;
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
 * `<db>.bak-rebuild-<timestamp>`. `VACUUM INTO` reads one snapshot, so a concurrent writer
 * cannot tear it, and it refuses a target that already exists. Must not run inside a transaction.
 */
export function backupProjectDatabase(db: DatabaseSync, dbPath: string, now: Date = new Date()): string {
  const target = `${dbPath}.bak-rebuild-${now.toISOString().replace(/[:.]/g, "-")}`;
  db.prepare("VACUUM INTO ?").run(target);
  return target;
}
