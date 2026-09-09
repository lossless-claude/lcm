import type { DatabaseSync } from "node:sqlite";

/**
 * How long after a compaction a restore still counts as the one that follows it.
 *
 * The mark exists because Claude Code does not always tell the restore why it fired, and
 * a post-compaction restore must replay the saved instructions rather than the episodic
 * memory. The window only has to cover PreCompact handing over to the next restore.
 */
export const JUST_COMPACTED_TTL_MS = 30_000;

/** Records that this session was just compacted, and drops marks past the window. */
export function markSessionCompacted(db: DatabaseSync, sessionId: string, now = Date.now()): void {
  db.prepare(
    "INSERT INTO session_compactions (session_id, compacted_at) VALUES (?, ?) " +
    "ON CONFLICT(session_id) DO UPDATE SET compacted_at = excluded.compacted_at",
  ).run(sessionId, now);
  // Nothing else prunes this table, and a stale mark is only noise, so every write pays
  // for the sweep of marks that can no longer match.
  db.prepare("DELETE FROM session_compactions WHERE compacted_at < ?").run(now - JUST_COMPACTED_TTL_MS);
}

/** Whether this session was compacted inside the window. */
export function wasSessionJustCompacted(db: DatabaseSync, sessionId: string, now = Date.now()): boolean {
  const row = db
    .prepare("SELECT compacted_at FROM session_compactions WHERE session_id = ?")
    .get(sessionId) as { compacted_at: number } | undefined;
  return row !== undefined && now - row.compacted_at < JUST_COMPACTED_TTL_MS;
}
