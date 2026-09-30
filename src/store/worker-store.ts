import type { DatabaseSync } from "node:sqlite";
import { clearConversationForRebuild } from "../claude-rebuild.js";

export const WORKER_WARNING = "This session and its subagents are not recorded by lcm. The harness's own transcript stays on disk. Use a dedicated session; forking a worker session is unsupported.";
export type WorkerEnrollment = {
  session_id: string; cwd: string; client: string; owner: string | null;
  state: "active" | "finished" | "abandoned"; last_activity: string;
};

/** Admission is live; capture exclusion is permanent, including recovered descendants. */
export class WorkerStore {
  constructor(private db: DatabaseSync) {}

  list(): WorkerEnrollment[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'summarize_workers'").get()) return [];
    return this.db.prepare("SELECT session_id, cwd, client, owner, state, last_activity FROM summarize_workers ORDER BY session_id").all() as WorkerEnrollment[];
  }

  excluded(sessionId: string, parentSessionId?: string | null): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'summarize_workers'").get()) return false;
    const row = this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
      SELECT ? UNION SELECT parent_session_id FROM conversations JOIN ancestors ON session_id = ancestors.id
      WHERE parent_session_id IS NOT NULL
    ) SELECT 1 FROM summarize_workers JOIN ancestors ON session_id = ancestors.id LIMIT 1`).get(sessionId);
    return Boolean(row || (parentSessionId && this.excluded(parentSessionId)));
  }

  live(sessionId: string, cwd: string, client: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM summarize_workers
      WHERE session_id = ? AND cwd = ? AND client = ? AND state = 'active' AND owner IS NOT NULL`).get(sessionId, cwd, client));
  }

  touch(sessionId: string): void {
    this.db.prepare("UPDATE summarize_workers SET last_activity = datetime('now') WHERE session_id = ?").run(sessionId);
  }

  finish(sessionId: string, state: "finished" | "abandoned" = "finished"): void {
    this.db.prepare("UPDATE summarize_workers SET state = ?, last_activity = datetime('now') WHERE session_id = ?").run(state, sessionId);
  }

  register(input: { sessionId: string; cwd: string; client: string; owner: string }): { sessions: string[]; unprovenanced: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE summarize_workers SET state = 'finished', last_activity = datetime('now')
        WHERE owner = ? AND session_id != ?`).run(input.owner, input.sessionId);
      this.db.prepare(`INSERT INTO summarize_workers(session_id, cwd, client, owner, state)
        VALUES (?, ?, ?, ?, 'active') ON CONFLICT(session_id) DO UPDATE SET
        owner = excluded.owner, state = 'active', last_activity = datetime('now')`).run(input.sessionId, input.cwd, input.client, input.owner);
      const sessions = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT ? UNION SELECT session_id FROM conversations JOIN descendants ON parent_session_id = descendants.id
      ) SELECT id FROM descendants`).all(input.sessionId) as { id: string }[];
      for (const { id } of sessions) this.exclude(id, input.cwd, input.client);
      const { n } = this.db.prepare("SELECT count(*) AS n FROM promoted WHERE session_id IS NULL AND source_summary_id IS NULL").get() as { n: number };
      this.db.exec("COMMIT");
      return { sessions: sessions.map(row => row.id), unprovenanced: n };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  detectCopiedClaim(sessionId: string, messages: Array<{ workerClaims?: string[]; workerPayloads?: string[] }>): boolean {
    for (const message of messages) for (const id of message.workerClaims ?? []) {
      this.db.prepare("INSERT OR IGNORE INTO worker_claim_markers(session_id, call_id) VALUES (?, ?)").run(sessionId, id);
    }
    for (const message of messages) for (const id of message.workerPayloads ?? []) {
      if (this.db.prepare("SELECT 1 FROM worker_claim_markers WHERE session_id = ? AND call_id = ?").get(sessionId, id)) return true;
    }
    return false;
  }

  /** Caller holds a write transaction; detection never grants admission. */
  exclude(sessionId: string, cwd = "", client = "claude"): void {
    this.db.prepare(`INSERT OR IGNORE INTO summarize_workers(session_id, cwd, client, state)
      VALUES (?, ?, ?, 'abandoned')`).run(sessionId, cwd, client);
    this.db.prepare(`DELETE FROM promoted_fts WHERE rowid IN (SELECT rowid FROM promoted
      WHERE session_id = ? OR source_summary_id IN (SELECT summary_id FROM summaries
        JOIN conversations USING(conversation_id) WHERE session_id = ?))`).run(sessionId, sessionId);
    this.db.prepare(`DELETE FROM promoted WHERE session_id = ? OR source_summary_id IN (
      SELECT summary_id FROM summaries JOIN conversations USING(conversation_id) WHERE session_id = ?)`)
      .run(sessionId, sessionId);
    const conversations = this.db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").all(sessionId) as { conversation_id: number }[];
    for (const { conversation_id } of conversations) clearConversationForRebuild(this.db, conversation_id, sessionId);

    this.db.prepare("INSERT OR IGNORE INTO session_ingest_log(session_id) VALUES (?)").run(sessionId);
  }
}
