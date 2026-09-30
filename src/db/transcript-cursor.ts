import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { ClaudeTranscriptCursor } from "../claude-transcript-reader.js";
import type { JsonlTranscriptCursor } from "../jsonl-transcript-reader.js";

/**
 * The byte-cursor checkpoint store for every append-only JSONL client
 * (Claude, Codex, OMP): a conversation belongs to one
 * client, so one row per conversation serves all adapters. The physical table
 * keeps its original name — renaming it would need a destructive migration for
 * no behavioral gain.
 */
export function ensureTranscriptCursorTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS codex_ingest_cursors (
    conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    transcript_path TEXT NOT NULL,
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    message_count INTEGER NOT NULL CHECK (message_count >= 0),
    file_device TEXT NOT NULL,
    file_inode TEXT NOT NULL,
    record_boundary INTEGER NOT NULL CHECK (record_boundary IN (0, 1)),
    prefix_fingerprint TEXT
  )`);
  const columns = db.prepare("PRAGMA table_info(codex_ingest_cursors)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "prefix_fingerprint")) {
    db.exec("ALTER TABLE codex_ingest_cursors ADD COLUMN prefix_fingerprint TEXT");
  }
  for (const [name, type] of [["claude_redaction_key", "TEXT"], ["claude_database_identity", "TEXT"], ["claude_last_message_id", "INTEGER"], ["claude_validated_count", "INTEGER"], ["claude_pending_fingerprint", "TEXT"]]) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE codex_ingest_cursors ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS claude_tool_use_models (
    conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    tool_use_id TEXT NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (conversation_id, tool_use_id)
  )`);
  // A durable validation is invalidated in the same transaction as a prefix mutation.
  // Appends are checked by messageCount; adding compaction's excluded event at the tail
  // must not force a full transcript scan.
  const invalidate = (ids: string) => `UPDATE codex_ingest_cursors SET prefix_fingerprint = NULL
    WHERE claude_redaction_key IS NOT NULL AND conversation_id IN (
      SELECT conversation_id FROM conversations WHERE session_id IN (${ids})
    );`;
  const messageSession = (row: string) => `SELECT session_id FROM conversations WHERE conversation_id = ${row}.conversation_id`;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS claude_cursor_message_update AFTER UPDATE OF conversation_id, seq, role, content ON messages
    WHEN OLD.conversation_id IS NOT NEW.conversation_id OR OLD.seq IS NOT NEW.seq OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content
    BEGIN ${invalidate(`${messageSession("OLD")} UNION ${messageSession("NEW")}`)} END;
    CREATE TRIGGER IF NOT EXISTS claude_cursor_message_delete BEFORE DELETE ON messages
    BEGIN ${invalidate(messageSession("OLD"))} END;
    CREATE TRIGGER IF NOT EXISTS claude_cursor_conversation_update AFTER UPDATE OF session_id, created_at, role_tagging, parser_shape ON conversations
    BEGIN ${invalidate("SELECT OLD.session_id UNION SELECT NEW.session_id")} END;
    CREATE TRIGGER IF NOT EXISTS claude_cursor_conversation_delete BEFORE DELETE ON conversations
    BEGIN ${invalidate("SELECT OLD.session_id")} END;
    CREATE TRIGGER IF NOT EXISTS claude_cursor_conversation_insert AFTER INSERT ON conversations
    BEGIN ${invalidate("SELECT NEW.session_id")} END;
  `);
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
    db.exec(`CREATE TRIGGER IF NOT EXISTS claude_cursor_part_${operation.toLowerCase()} AFTER ${operation} ON message_parts
      BEGIN ${rows.map(row => `UPDATE codex_ingest_cursors SET prefix_fingerprint = NULL
        WHERE claude_redaction_key IS NOT NULL AND ${row}.part_type = 'compaction'
        AND ${row}.message_id <= claude_last_message_id AND conversation_id IN (
          SELECT c.conversation_id FROM conversations c JOIN conversations changed ON changed.session_id = c.session_id
          JOIN messages m ON m.conversation_id = changed.conversation_id WHERE m.message_id = ${row}.message_id
        );`).join("\n")} END;`);
  }
}

const memoryIdentities = new WeakMap<DatabaseSync, string>();
function databaseIdentity(db: DatabaseSync): string {
  const rows = db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const file = rows.find(row => row.name === "main")!.file;
  if (file) {
    const stat = statSync(file, { bigint: true });
    return JSON.stringify([file, stat.dev.toString(), stat.ino.toString()]);
  }
  if (!memoryIdentities.has(db)) memoryIdentities.set(db, randomUUID());
  return memoryIdentities.get(db)!;
}

/** Claude checkpoints additionally bind a successful prefix validation to its database and redaction rules. */
export function loadClaudeTranscriptCursor(db: DatabaseSync, conversationId: number, path: string): ClaudeTranscriptCursor | undefined {
  const row = db.prepare(`SELECT claude_redaction_key, claude_database_identity, claude_validated_count, claude_pending_fingerprint
    FROM codex_ingest_cursors WHERE conversation_id = ?`)
    .get(conversationId) as { claude_redaction_key: string | null; claude_database_identity: string | null;
      claude_validated_count: number | null; claude_pending_fingerprint: string | null } | undefined;
  if (!row || row.claude_redaction_key === null || row.claude_database_identity !== databaseIdentity(db)) return undefined;
  const cursor = loadTranscriptCursor(db, conversationId, path);
  return cursor && { ...cursor, redactionKey: row.claude_redaction_key,
    validatedCount: row.claude_validated_count ?? undefined, pendingFingerprint: row.claude_pending_fingerprint ?? undefined };
}

/** Called inside capture's append transaction, after its scrubbing and parser restamp. */
export function saveClaudeTranscriptCursor(db: DatabaseSync, conversationId: number, path: string, cursor: ClaudeTranscriptCursor): void {
  saveTranscriptCursor(db, { conversationId, transcriptPath: path, cursor });
  db.prepare(`UPDATE codex_ingest_cursors SET claude_redaction_key = ?, claude_database_identity = ?,
    claude_validated_count = ?, claude_pending_fingerprint = ?,
    claude_last_message_id = (SELECT MAX(m.message_id) FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE c.session_id = (SELECT session_id FROM conversations WHERE conversation_id = ?)) WHERE conversation_id = ?`)
    .run(cursor.redactionKey, databaseIdentity(db), cursor.validatedCount ?? cursor.messageCount,
      cursor.pendingFingerprint ?? null, conversationId, conversationId);
  const save = db.prepare(`INSERT INTO claude_tool_use_models (conversation_id, tool_use_id, model) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id, tool_use_id) DO UPDATE SET model = excluded.model`);
  if (cursor.replaceToolUseModels) db.prepare("DELETE FROM claude_tool_use_models WHERE conversation_id = ?").run(conversationId);
  for (const [id, model] of cursor.toolUseModels ?? []) save.run(conversationId, id, model);
}

/** A rebuild's full parse retires both the volatile memo and the durable prefix proof. */
export function invalidateClaudeTranscriptCursor(db: DatabaseSync, sessionId: string): void {
  db.prepare(`UPDATE codex_ingest_cursors SET prefix_fingerprint = NULL WHERE claude_redaction_key IS NOT NULL
    AND conversation_id IN (SELECT conversation_id FROM conversations WHERE session_id = ?)`)
    .run(sessionId);
}

/** Indexed lookups only for events still waiting; old transcript bytes are never read for a late event. */
export function loadClaudeToolUseModels(db: DatabaseSync, conversationId: number, ids: readonly string[]): Map<string, string> {
  const query = db.prepare("SELECT model FROM claude_tool_use_models WHERE conversation_id = ? AND tool_use_id = ?");
  const models = new Map<string, string>();
  for (const id of ids) {
    const row = query.get(conversationId, id) as { model: string } | undefined;
    if (row) models.set(id, row.model);
  }
  return models;
}

export function loadTranscriptCursor(
  db: DatabaseSync, conversationId: number, transcriptPath: string,
): JsonlTranscriptCursor | undefined {
  const row = db.prepare(`SELECT byte_offset, message_count, file_device, file_inode, record_boundary, prefix_fingerprint
    FROM codex_ingest_cursors WHERE conversation_id = ? AND transcript_path = ?`)
    .get(conversationId, transcriptPath) as {
      byte_offset: number; message_count: number; file_device: string; file_inode: string; record_boundary: number;
      prefix_fingerprint: string | null;
    } | undefined;
  return row ? {
    offset: row.byte_offset, messageCount: row.message_count,
    device: row.file_device, inode: row.file_inode, recordBoundary: row.record_boundary === 1,
    fingerprint: row.prefix_fingerprint ?? undefined,
  } : undefined;
}

/** Commit only in the same transaction that appends the corresponding messages. */
export function saveTranscriptCursor(
  db: DatabaseSync,
  checkpoint: { conversationId: number; transcriptPath: string; cursor: JsonlTranscriptCursor },
): void {
  const { conversationId, transcriptPath, cursor } = checkpoint;
  db.prepare(`INSERT INTO codex_ingest_cursors
    (conversation_id, transcript_path, byte_offset, message_count, file_device, file_inode, record_boundary, prefix_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      transcript_path = excluded.transcript_path, byte_offset = excluded.byte_offset,
      message_count = excluded.message_count, file_device = excluded.file_device,
      file_inode = excluded.file_inode, record_boundary = excluded.record_boundary,
      prefix_fingerprint = excluded.prefix_fingerprint`)
    .run(conversationId, transcriptPath, cursor.offset, cursor.messageCount,
      cursor.device, cursor.inode, cursor.recordBoundary ? 1 : 0, cursor.fingerprint ?? null);
}
