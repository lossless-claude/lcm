import type { DatabaseSync } from "node:sqlite";

export type MessageCoverage = { conversationId: number; messageId: number; coverage: number };

/**
 * How often its own conversation's context covers each captured message: as a message
 * item, or as a source of a summary reached from a summary item through summary_parents.
 * Compaction replaces a range with a summary of exactly that range and capture appends
 * after it, so a sound context covers every message once; 0 is a lost message and more
 * than 1 a duplicated one. Compaction-event messages are never context, and a timeline
 * conversation's summaries cite other conversations, so both are left out. Only a source
 * of lower depth is followed, so malformed lineage, a cycle included, never proves
 * coverage. Read-only, and it reads a database this version has not migrated.
 */
export function countContextCoverage(db: DatabaseSync, conversationId?: number): MessageCoverage[] {
  const hasTimeline = (db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>)
    .some(column => column.name === "is_timeline");
  const timelineOwner = (column: string) => hasTimeline
    ? `EXISTS (SELECT 1 FROM conversations owner WHERE owner.conversation_id = ${column} AND owner.is_timeline = 1)`
    : "0";
  const scope = conversationId === undefined ? "" : "AND m.conversation_id = ?";
  return db.prepare(`
    WITH RECURSIVE reached(conversation_id, summary_id, depth) AS (
      SELECT ci.conversation_id, s.summary_id, s.depth FROM context_items ci
      JOIN summaries s ON s.summary_id = ci.summary_id
      WHERE ci.item_type = 'summary' AND NOT ${timelineOwner("ci.conversation_id")}
      UNION ALL
      SELECT reached.conversation_id, source.summary_id, source.depth FROM reached
      JOIN summary_parents sp ON sp.summary_id = reached.summary_id
      JOIN summaries source ON source.summary_id = sp.parent_summary_id AND source.depth < reached.depth
    ),
    covered(conversation_id, message_id) AS (
      SELECT conversation_id, message_id FROM context_items WHERE item_type = 'message'
      UNION ALL
      SELECT reached.conversation_id, sm.message_id FROM reached
      JOIN summary_messages sm ON sm.summary_id = reached.summary_id
    )
    SELECT m.conversation_id AS conversationId, m.message_id AS messageId, COUNT(covered.message_id) AS coverage
    FROM messages m
    LEFT JOIN covered ON covered.conversation_id = m.conversation_id AND covered.message_id = m.message_id
    WHERE NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
      AND NOT ${timelineOwner("m.conversation_id")} ${scope}
    GROUP BY m.message_id
    ORDER BY m.conversation_id, m.seq
  `).all(...(conversationId === undefined ? [] : [conversationId])) as MessageCoverage[];
}
