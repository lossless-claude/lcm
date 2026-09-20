import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { fenceContent } from "../content-fence.js";
import { PromotedStore } from "../../db/promoted.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";

/**
 * The two memory layers a restore reads: the session's own summaries out of Episodic
 * memory, and the project's Promoted memory. Both read a caller-owned connection.
 */

/**
 * The session's own recent summaries, deepest first, fenced under
 * `<recent-session-context>`.
 *
 * A session with no id matches no conversation, and binding a non-string one throws —
 * which would take the promoted memory and the snapshot refresh down with it, silently.
 */
export async function readEpisodicContext(db: DatabaseSync, sessionId: string | undefined, limit: number): Promise<string> {
  if (!sessionId) return "";
  const conversation = await new ConversationStore(db).getConversationBySessionId(sessionId);
  if (!conversation) return "";
  const rows = await new SummaryStore(db).summariesDeepestFirst(conversation.conversationId, limit);
  if (rows.length === 0) return "";
  return fenceContent(rows.map((r) => r.content).join("\n\n"), "recent-session-context");
}

/** The project's promoted memories, recent enough to still be worth restoring. */
export function readPromotedMemories(db: DatabaseSync, cwd: string, config: DaemonConfig): string[] {
  const cutoffMs = Date.now() - config.restoration.restoreMaxPromotedAgeDays * 24 * 60 * 60 * 1000;
  // Fetch more candidates than needed, then filter by age before capping: otherwise old
  // memories consume the five slots while newer ones exist.
  return new PromotedStore(db)
    .search(`project context ${cwd}`, 20)
    .filter((r) => !r.createdAt || Date.parse(r.createdAt) >= cutoffMs)
    .slice(0, 5)
    .map((r) => r.content);
}