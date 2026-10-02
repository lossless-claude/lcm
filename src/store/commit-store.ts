import type { DatabaseSync } from "node:sqlite";
import { yieldToEventLoop } from "../daemon/project-queue.js";
import { SUMMARY_SOURCE_IDS_SQL } from "./summary-lineage.js";

export type CommitReference = {
  sessionId: string; messageId: number; hash: string; subject: string | null;
  authorAt: string | null; committedAt: string | null; branch: string | null; resolved: boolean;
  evidence: "commit-output" | "session-trailer"; evidenceValue: string;
};
export type CommitCandidate = { message_id: number; conversation_id: number; session_id: string; role: string; content: string; tool_output: string | null };
export type TrailerCandidate = Pick<CommitCandidate, "message_id" | "conversation_id" | "session_id"> & { url: string };
type Row = { session_id: string; message_id: number; hash: string; subject: string | null; author_at: string | null; committed_at: string | null; branch: string | null; resolved: number; evidence: CommitReference["evidence"]; evidence_value: string };
const reference = (row: Row): CommitReference => ({
  sessionId: row.session_id, messageId: row.message_id, hash: row.hash, subject: row.subject,
  authorAt: row.author_at, committedAt: row.committed_at, branch: row.branch, resolved: row.resolved === 1, evidence: row.evidence, evidenceValue: row.evidence_value,
});
const CANDIDATE_PAGE_SIZE = 256;
const OUTPUT_HASH_PREFILTER = "*[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*";

/** Explicit evidence and reference metadata only; no git content is retained. */
export class CommitStore {
  constructor(private db: DatabaseSync) {}

  isCurrentDeclaration(candidate: TrailerCandidate): boolean {
    return this.db.prepare(`SELECT 1 FROM session_web_urls u JOIN conversations c USING(session_id)
      JOIN messages m USING(conversation_id)
      WHERE u.session_id = ? AND u.url = ? AND m.message_id = ? AND c.is_timeline = 0
        AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')`)
      .get(candidate.session_id, candidate.url, candidate.message_id) !== undefined;
  }

  async *declarationPages(): AsyncGenerator<TrailerCandidate[]> {
    let sessionId = "", url = "";
    const page = this.db.prepare(`SELECT u.session_id, u.url, m.message_id, m.conversation_id
      FROM session_web_urls u JOIN messages m ON m.message_id = (
        SELECT first.message_id FROM messages first JOIN conversations c USING(conversation_id)
        WHERE c.session_id = u.session_id AND c.is_timeline = 0
          AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = first.message_id AND p.part_type = 'compaction')
        ORDER BY first.message_id LIMIT 1
      )
      WHERE (u.session_id, u.url) > (?, ?) ORDER BY u.session_id, u.url LIMIT ${CANDIDATE_PAGE_SIZE}`);
    for (;;) {
      const rows = page.all(sessionId, url) as TrailerCandidate[];
      if (rows.length) yield rows;
      await yieldToEventLoop();
      if (rows.length < CANDIDATE_PAGE_SIZE) return;
      ({ session_id: sessionId, url } = rows.at(-1)!);
    }
  }

  isCurrentCandidate(candidate: CommitCandidate): boolean {
    const row = this.db.prepare(`SELECT m.role, m.content,
      (SELECT group_concat(p.tool_output, char(10)) FROM message_parts p WHERE p.message_id = m.message_id
        AND p.part_type = 'tool' AND p.session_id = c.session_id AND p.tool_output IS NOT NULL) tool_output
      FROM messages m JOIN conversations c USING(conversation_id)
      WHERE m.message_id = ? AND m.conversation_id = ? AND c.session_id = ? AND c.is_timeline = 0
        AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')`)
      .get(candidate.message_id, candidate.conversation_id, candidate.session_id) as Pick<CommitCandidate, "role" | "content" | "tool_output"> | undefined;
    return row !== undefined && row.role === candidate.role && row.content === candidate.content && row.tool_output === candidate.tool_output;
  }

  async *candidatePages(): AsyncGenerator<CommitCandidate[]> {
    let id = 0;
    const page = this.db.prepare(`SELECT m.message_id, m.conversation_id, c.session_id, m.role, m.content,
      (SELECT group_concat(p.tool_output, char(10)) FROM message_parts p WHERE p.message_id = m.message_id
        AND p.part_type = 'tool' AND p.session_id = c.session_id AND p.tool_output IS NOT NULL) tool_output
      FROM messages m JOIN conversations c USING(conversation_id)
      WHERE m.message_id > ? AND c.is_timeline = 0
        AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
        AND ((m.role = 'tool' AND (m.content LIKE '%[%]%' OR m.content LIKE '%commit %' OR lower(m.content) GLOB '${OUTPUT_HASH_PREFILTER}'))
          OR EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'tool' AND p.session_id = c.session_id
            AND (p.tool_output LIKE '%[%]%' OR p.tool_output LIKE '%commit %' OR lower(p.tool_output) GLOB '${OUTPUT_HASH_PREFILTER}')))
      ORDER BY m.message_id LIMIT ${CANDIDATE_PAGE_SIZE}`);
    for (;;) {
      const rows = page.all(id) as CommitCandidate[];
      if (rows.length) yield rows;
      await yieldToEventLoop();
      if (rows.length < CANDIDATE_PAGE_SIZE) return;
      id = rows.at(-1)!.message_id;
    }
  }

  async *referencePages(): AsyncGenerator<CommitReference[]> {
    let id = 0;
    for (;;) {
      const rows = this.db.prepare(`SELECT rowid reference_id, * FROM session_commits WHERE rowid > ?
        ORDER BY rowid LIMIT ${CANDIDATE_PAGE_SIZE}`).all(id) as Array<Row & { reference_id: number }>;
      if (rows.length) yield rows.map(reference);
      await yieldToEventLoop();
      if (rows.length < CANDIDATE_PAGE_SIZE) return;
      id = rows.at(-1)!.reference_id;
    }
  }

  markUnresolved(ref: CommitReference): number | null {
    this.db.prepare(`UPDATE session_commits SET resolved = 0
      WHERE message_id = ? AND evidence = ? AND evidence_value = ? AND hash = ?`)
      .run(ref.messageId, ref.evidence, ref.evidenceValue, ref.hash);
    if (ref.evidence !== "commit-output") return null;
    const changed = this.db.prepare(`UPDATE messages SET event_at = NULL, event_time_source = NULL
      WHERE message_id = ? AND event_time_source = 'commit' AND NOT EXISTS (
        SELECT 1 FROM session_commits WHERE message_id = messages.message_id AND evidence = 'commit-output'
          AND resolved = 1 AND julianday(committed_at) = julianday(messages.event_at)
      ) RETURNING conversation_id`).get(ref.messageId) as { conversation_id: number } | undefined;
    return changed?.conversation_id ?? null;
  }

  find(key: Pick<CommitReference, "messageId" | "evidence" | "evidenceValue"> & { sessionId: string; hash?: string }): CommitReference | null {
    const trailer = key.evidence === "session-trailer";
    const row = this.db.prepare(`SELECT * FROM session_commits WHERE ${trailer ? "session_id" : "message_id"} = ? AND evidence = ?
      ${trailer ? "" : "AND evidence_value = ?"} ${key.hash ? "AND hash = ?" : ""} LIMIT 1`)
      .get(trailer ? key.sessionId : key.messageId, key.evidence,
        ...(trailer ? [] : [key.evidenceValue]), ...(key.hash ? [key.hash] : [])) as Row | undefined;
    return row ? reference(row) : null;
  }

  record(ref: CommitReference): void {
    const prior = ref.evidence === "session-trailer" ? this.find(ref) : null;
    this.db.prepare(`INSERT INTO session_commits(session_id, message_id, hash, subject, author_at, committed_at, branch, resolved, evidence, evidence_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id, evidence, evidence_value, hash)
      DO UPDATE SET resolved = excluded.resolved, committed_at = excluded.committed_at`)
      .run(ref.sessionId, prior?.messageId ?? ref.messageId, ref.hash, ref.subject, ref.authorAt, ref.committedAt, ref.branch,
        Number(ref.resolved), ref.evidence, prior?.evidenceValue ?? ref.evidenceValue);
  }

  anchor(messageId: number, ref: CommitReference | null): number {
    const date = ref?.evidence === "commit-output" && ref.resolved && this.find(ref)?.resolved ? ref.committedAt : null;
    return Number(this.db.prepare(`UPDATE messages SET event_at = ?, event_time_source = ?
      WHERE message_id = ? AND (event_time_source = 'commit' OR event_at IS NULL)
        AND (event_at IS NOT ? OR event_time_source IS NOT ?)`)
      .run(date, date ? "commit" : null, messageId, date, date ? "commit" : null).changes);
  }

  needsEvidenceRepair(): boolean {
    this.db.exec("CREATE TABLE IF NOT EXISTS commit_evidence_backfill (id INTEGER PRIMARY KEY CHECK(id = 1))");
    return !this.db.prepare("SELECT 1 FROM commit_evidence_backfill WHERE id = 1").get();
  }

  repairLegacyEvidence(): void {
    // Trailer matches identify a session, never the event that made a commit.
    this.db.prepare(`UPDATE messages SET event_at = NULL, event_time_source = NULL
      WHERE event_time_source = 'commit' AND message_id IN (SELECT message_id FROM session_commits)
        AND ((SELECT COUNT(DISTINCT hash) FROM session_commits WHERE message_id = messages.message_id
          AND evidence = 'commit-output') != 1 OR NOT EXISTS (
          SELECT 1 FROM session_commits WHERE message_id = messages.message_id AND evidence = 'commit-output'
            AND resolved = 1 AND (committed_at IS NULL OR julianday(committed_at) = julianday(messages.event_at))
        ))`).run();
    this.db.exec(`DELETE FROM session_commits WHERE evidence = 'session-trailer' AND rowid NOT IN (
      SELECT MIN(rowid) FROM session_commits WHERE evidence = 'session-trailer' GROUP BY session_id, hash
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_commits_trailer_idx ON session_commits(session_id, hash)
      WHERE evidence = 'session-trailer';`);
  }

  /** Every conversation of a session with commit evidence: the same set on any rerun. */
  conversationsWithCommits(): number[] {
    return (this.db.prepare(`SELECT conversation_id FROM conversations
      WHERE session_id IN (SELECT DISTINCT session_id FROM session_commits) ORDER BY conversation_id`).all() as Array<{ conversation_id: number }>)
      .map(row => row.conversation_id);
  }

  finishEvidenceRepair(): void {
    this.db.prepare("INSERT INTO commit_evidence_backfill (id) VALUES (1)").run();
  }

  repairTrailerIdentityOnce(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS session_trailer_identity_backfill (id INTEGER PRIMARY KEY CHECK(id = 1))");
    if (this.db.prepare("SELECT 1 FROM session_trailer_identity_backfill WHERE id = 1").get()) return;
    this.db.prepare("DELETE FROM session_commits WHERE evidence = 'session-trailer'").run();
    this.db.prepare("INSERT INTO session_trailer_identity_backfill (id) VALUES (1)").run();
  }

  forSession(sessionId: string): CommitReference[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_commits'").get()) return [];
    return (this.db.prepare("SELECT * FROM session_commits WHERE session_id = ? ORDER BY committed_at, hash, message_id, evidence")
      .all(sessionId) as Row[]).map(reference);
  }

  forSummary(summaryId: string): CommitReference[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_commits'").get()) return [];
    return (this.db.prepare(`SELECT * FROM session_commits WHERE session_id IN (
      SELECT c.session_id FROM summaries s JOIN conversations c USING(conversation_id)
        WHERE s.summary_id IN (${SUMMARY_SOURCE_IDS_SQL}) AND c.is_timeline = 0
      UNION SELECT session_id FROM timeline_sources WHERE summary_id = ?
    ) ORDER BY committed_at, hash, message_id, evidence`).all(summaryId, summaryId) as Row[]).map(reference);
  }
}
