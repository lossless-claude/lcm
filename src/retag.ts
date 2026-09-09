import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * Re-labelling the rows an older parser already stored.
 *
 * Before role tagging, a tool result was stored under `user` — the turn Claude
 * Code puts it in — so most of the "user" corpus was never a person talking.
 * The text is right; only the label is wrong.
 *
 * Nothing is deleted and nothing is inserted. `summary_messages` and
 * `context_items` reference `message_id` with `ON DELETE RESTRICT`, so a
 * compacted conversation cannot have its rows replaced at all; and appending
 * the tool calls the old parser dropped would renumber `seq` under every
 * summary that points into it. Only `messages.role` changes, and only where
 * the stored text still matches the transcript.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  content?: string | ContentBlock[];
}

/** One row as the old parser would have stored it, with the role it should carry. */
export interface RetagEntry {
  content: string;
  role: string;
}

function extractText(content: string | ContentBlock[] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => {
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "tool_result") return extractText(b.content);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Replays a transcript the way the pre-tagging parser read it — same entries
 * kept, same text extracted, same order — and states the role each row should
 * carry under the tagging rules.
 *
 * Entries the old parser dropped stay dropped. A tool call extracted to an
 * empty string back then and was skipped; adding it now would shift every
 * later `seq`.
 */
export function retagEntries(transcriptPath: string): RetagEntry[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf-8");
  } catch {
    return [];
  }

  const entries: RetagEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { message?: { role?: string; content?: string | ContentBlock[] } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entryRole = parsed.message?.role;
    if (!entryRole || !["user", "assistant", "system"].includes(entryRole)) continue;
    const content = extractText(parsed.message?.content);
    if (!content.trim()) continue;

    const blocks = Array.isArray(parsed.message?.content) ? parsed.message!.content as ContentBlock[] : [];
    const prose = blocks.some(b => b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
    const isTool = blocks.length > 0 && !prose && blocks.some(b => b.type === "tool_result");
    entries.push({ content, role: isTool ? "tool" : entryRole });
  }
  return entries;
}

export interface RetagOutcome {
  /** Rows whose role changed. */
  retagged: number;
  /** Rows the transcript agreed with, left as they were. */
  unchanged: number;
  /** Why the conversation was left alone, when it was. */
  skipped?: "no-transcript" | "length-mismatch" | "content-mismatch" | "already-tagged";
}

interface StoredMessage {
  message_id: number;
  seq: number;
  role: string;
  content: string;
}

/**
 * Re-labels one conversation's rows from its transcript.
 *
 * Refuses on any disagreement rather than guessing: if the transcript no
 * longer lines up with what was stored, the rows keep the labels they have and
 * the conversation stays unknown. Guessing a tag from text alone was measured
 * at 89.3% precision, which calls the user a log 240 times — the exact failure
 * this exists to end.
 */
export function retagConversation(
  db: DatabaseSync,
  conversationId: number,
  transcriptPath: string,
): RetagOutcome {
  const tagging = db
    .prepare("SELECT role_tagging FROM conversations WHERE conversation_id = ?")
    .get(conversationId) as { role_tagging?: string | null } | undefined;
  if (tagging?.role_tagging === "tagged") return { retagged: 0, unchanged: 0, skipped: "already-tagged" };

  const entries = retagEntries(transcriptPath);
  if (entries.length === 0) return { retagged: 0, unchanged: 0, skipped: "no-transcript" };

  const stored = db
    .prepare("SELECT message_id, seq, role, content FROM messages WHERE conversation_id = ? ORDER BY seq")
    .all(conversationId) as unknown as StoredMessage[];
  // A transcript that kept growing after the session was ingested still holds
  // the stored rows as its prefix, so it can label them. A transcript with
  // fewer rows than the store has diverged and is not trusted at all.
  if (stored.length > entries.length) return { retagged: 0, unchanged: 0, skipped: "length-mismatch" };

  for (let i = 0; i < stored.length; i++) {
    if (stored[i].content !== entries[i].content) {
      return { retagged: 0, unchanged: 0, skipped: "content-mismatch" };
    }
  }

  const update = db.prepare("UPDATE messages SET role = ? WHERE message_id = ?");
  let retagged = 0;
  for (let i = 0; i < stored.length; i++) {
    if (stored[i].role === entries[i].role) continue;
    update.run(entries[i].role, stored[i].message_id);
    retagged++;
  }
  db.prepare("UPDATE conversations SET role_tagging = 'tagged' WHERE conversation_id = ?").run(conversationId);
  return { retagged, unchanged: stored.length - retagged };
}
