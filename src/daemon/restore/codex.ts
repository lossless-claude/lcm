import type { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { fitRecentContextItems } from "./budget.js";

/**
 * Codex's recent context: the conversation's context items — summaries and the last
 * messages — rather than Claude Code's summary chain, trimmed to what is left of the
 * injection budget.
 *
 * A session that has captured nothing yet is shown the project's latest active
 * conversation instead, so a metadata-only start does not restore from an empty shell.
 */
export async function readCodexContext(
  db: DatabaseSync,
  sessionId: string | undefined,
  source: string | undefined,
  itemLimit: number,
  byteBudget: number,
): Promise<string> {
  const limit = Math.max(0, Math.floor(itemLimit));
  if (limit === 0) return "";
  const conversations = new ConversationStore(db);
  const summaries = new SummaryStore(db);
  const current = sessionId ? await conversations.getConversationBySessionId(sessionId) : null;

  let conversation = current;
  let rows = conversation ? await summaries.readContextWindow(conversation.conversationId, limit) : [];
  let isCurrentSession = rows.length > 0;

  // SessionStart can run after a metadata-only ingest has created the new conversation.
  // An empty shell must not mask the latest useful context from the same project.
  if (rows.length === 0 && source === "startup") {
    conversation = await conversations.latestActiveConversation(sessionId ?? "");
    rows = conversation ? await summaries.readContextWindow(conversation.conversationId, limit) : [];
    isCurrentSession = false;
  }

  if (!conversation || rows.length === 0) return "";

  const speaker = (role: string | null) => (role === "assistant" ? "Assistant" : "User");
  const items = rows.map((row) => row.itemType === "summary"
    ? `Summary:\n${row.content}`
    : `${speaker(row.role)}:\n${row.content}`);
  const tag = isCurrentSession ? "recent-session-context" : "recent-project-context";
  return fitRecentContextItems(items, tag, byteBudget);
}