import type { DatabaseSync } from "node:sqlite";
import type { ParsedMessage } from "../transcript.js";
import type { TranscriptToolCall } from "../tool-calls.js";
import type { ScrubEngine } from "../scrub.js";
import { normalizeMessageContent } from "../message-content.js";
import { getLcmDbFeatures } from "../db/features.js";

const TRUNCATION_MARKER = "\n[truncated]";

function storedInput(call: TranscriptToolCall, scrubber: ScrubEngine): { text: string | null; truncated: number } {
  const { input, inputLimit } = call;
  if (input === undefined) return { text: null, truncated: 0 };
  const text = normalizeMessageContent(scrubber.scrubWithCounts(input).text);
  const bytes = Buffer.from(text);
  if (inputLimit === undefined || bytes.length <= inputLimit) return { text, truncated: 0 };
  let end = inputLimit - Buffer.byteLength(TRUNCATION_MARKER);
  // A UTF-8 continuation byte cannot start the omitted suffix.
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8") + TRUNCATION_MARKER, truncated: 1 };
}

/** Call ids join later results; only a verified stored message can establish a call. */
export function recordTranscriptToolCalls(
  db: DatabaseSync, sessionId: string, calls: readonly TranscriptToolCall[],
  messageIds: ReadonlyMap<ParsedMessage, number>, scrubber: ScrubEngine,
): void {
  if (calls.length === 0) return;
  const insert = db.prepare(`INSERT INTO transcript_tool_calls
    (session_id, call_id, message_id, name, input, input_bytes, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, call_id) DO NOTHING`);
  const update = db.prepare(`UPDATE transcript_tool_calls SET outcome = ?, harness_error = ?, exit_code = ?
    WHERE session_id = ? AND call_id = ?`);
  const indexed = new Set<number>();
  for (const call of calls) {
    if (call.name !== undefined) {
      const messageId = call.message && messageIds.get(call.message);
      if (messageId === undefined) continue;
      const input = storedInput(call, scrubber);
      insert.run(sessionId, call.callId, messageId, normalizeMessageContent(scrubber.scrubWithCounts(call.name).text),
        input.text, call.inputBytes ?? null, input.truncated);
      indexed.add(messageId);
    } else {
      update.run(call.outcome, call.harnessError === null ? null : Number(call.harnessError), call.exitCode, sessionId, call.callId);
    }
  }
  if (!getLcmDbFeatures(db).fts5Available || indexed.size === 0 ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get()) return;
  const content = db.prepare(`SELECT m.content || char(10) || COALESCE((
    SELECT group_concat(input, char(10)) FROM transcript_tool_calls WHERE message_id = m.message_id
  ), '') AS content FROM messages m WHERE m.message_id = ?`);
  const remove = db.prepare("DELETE FROM messages_fts WHERE rowid = ?");
  const index = db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)");
  for (const messageId of indexed) {
    const row = content.get(messageId) as { content: string } | undefined;
    if (!row) continue;
    remove.run(messageId);
    index.run(messageId, row.content);
  }
}
