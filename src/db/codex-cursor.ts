import type { DatabaseSync } from "node:sqlite";
import type { CodexTranscriptCursor } from "../codex-transcript-reader.js";

export function ensureCodexCursorTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_ingest_cursors (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    transcript_path TEXT NOT NULL,
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    message_count INTEGER NOT NULL CHECK (message_count >= 0),
    file_device TEXT NOT NULL,
    file_inode TEXT NOT NULL,
    record_boundary INTEGER NOT NULL CHECK (record_boundary IN (0, 1))
  )`);
}

export function loadCodexCursor(
  db: DatabaseSync, conversationId: number, transcriptPath: string,
): CodexTranscriptCursor | undefined {
  const row = db.prepare(`SELECT byte_offset, message_count, file_device, file_inode, record_boundary
    FROM codex_ingest_cursors WHERE conversation_id = ? AND transcript_path = ?`)
    .get(conversationId, transcriptPath) as {
      byte_offset: number; message_count: number; file_device: string; file_inode: string; record_boundary: number;
    } | undefined;
  return row ? {
    offset: row.byte_offset, messageCount: row.message_count,
    device: row.file_device, inode: row.file_inode, recordBoundary: row.record_boundary === 1,
  } : undefined;
}

/** Commit only in the same transaction that appends the corresponding messages. */
export function saveCodexCursor(
  db: DatabaseSync,
  checkpoint: { conversationId: number; transcriptPath: string; cursor: CodexTranscriptCursor },
): void {
  const { conversationId, transcriptPath, cursor } = checkpoint;
  db.prepare(`INSERT INTO codex_ingest_cursors
    (conversation_id, transcript_path, byte_offset, message_count, file_device, file_inode, record_boundary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      transcript_path = excluded.transcript_path, byte_offset = excluded.byte_offset,
      message_count = excluded.message_count, file_device = excluded.file_device,
      file_inode = excluded.file_inode, record_boundary = excluded.record_boundary`)
    .run(conversationId, transcriptPath, cursor.offset, cursor.messageCount,
      cursor.device, cursor.inode, cursor.recordBoundary ? 1 : 0);
}
