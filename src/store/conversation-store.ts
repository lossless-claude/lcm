import { SUMMARY_SOURCE_IDS_SQL } from "./summary-lineage.js";
import { TIMELINE_SESSION_ID } from "../db/project-timeline.js";
import { WorkerStore } from "./worker-store.js";
import { CommitStore } from "./commit-store.js";
import type { DatabaseSync } from "node:sqlite";
import { parseSqliteDate } from "../db/sqlite-date.js";
import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  byRankThenNewest,
  prepareFts5Query,
  shouldRetryWithLike,
  likePlanForPreparedQuery,
  type Fts5PreparedQuery,
} from "./fts5-query.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";
import { validateRegex } from "./regex-safety.js";

const memoryDatabaseIds = new WeakMap<DatabaseSync, string>();

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry"
  | "skill"
  | "command";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  eventAt?: Date | null;
};

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
  eventAt?: Date | null;
  eventTimeSource?: "transcript" | "commit" | null;
};

export type CreateMessagePartInput = {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
};

/**
 * Subagent attribution, carried from the transcript's `.meta.json` sidecar
 * (see src/subagent-attribution.ts). Undefined/null for ordinary sessions.
 */
export type SubagentAttributionInput = {
  parentSessionId?: string | null;
  subagentType?: string | null;
  subagentDesc?: string | null;
};

export type CreateConversationInput = {
  sessionId: string;
  title?: string;
  parserShape?: string | null;
  /** The transcript entry whose clear opens this conversation; absent for a session's first. */
  openedByEntryId?: string;
} & SubagentAttributionInput;

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** "tagged" when the rows separate tool output from human text; null when unknown. */
  roleTagging: "tagged" | null;
  /** Claude parser output shape, or null when it cannot be established. */
  parserShape: string | null;
  parentSessionId: string | null;
  subagentType: string | null;
  subagentDesc: string | null;
};

export type MessageSearchInput = {
  summaryId?: string;
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
  /** Terms a caller already extracted (a pivot-query union); re-extracting the string would lose them. */
  terms?: readonly string[];
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  bootstrapped_at: string | null;
  created_at: string;
  updated_at: string;
  role_tagging: string | null;
  parser_shape: string | null;
  parent_session_id: string | null;
  subagent_type: string | null;
  subagent_desc: string | null;
}

interface MessageRow {
  event_at: string | null;
  event_time_source: "transcript" | "commit" | null;
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

const CONVERSATION_SELECT_COLUMNS = `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at,
       role_tagging, parser_shape, parent_session_id, subagent_type, subagent_desc`;

// ── Row mappers ───────────────────────────────────────────────────────────────

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    title: row.title,
    bootstrappedAt: row.bootstrapped_at ? parseSqliteDate(row.bootstrapped_at) : null,
    createdAt: parseSqliteDate(row.created_at),
    updatedAt: parseSqliteDate(row.updated_at),
    roleTagging: row.role_tagging === "tagged" ? "tagged" : null,
    parserShape: row.parser_shape,
    parentSessionId: row.parent_session_id,
    subagentType: row.subagent_type,
    subagentDesc: row.subagent_desc,
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  if (row.event_time_source != null && row.event_time_source !== "transcript" && row.event_time_source !== "commit") {
    throw new Error("Invalid event time source");
  }
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    eventAt: row.event_at ? parseSqliteDate(row.event_at) : null,
    eventTimeSource: row.event_time_source ?? (row.event_at ? "transcript" : null),
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: parseSqliteDate(row.created_at),
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: parseSqliteDate(row.created_at),
    rank: row.rank,
  };
}

/**
 * Excludes, from a query over `messages m`, the rows compaction writes itself: no transcript
 * holds them, so what capture compares with a transcript leaves them out. The discriminator is
 * the message part, not role='system' — genuine transcript messages carry that role too.
 */
const NOT_COMPACTION_EVENT = `NOT EXISTS (
  SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
)`;

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fts5Available: boolean;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
  }

  private sessionFilter(alias = ""): string {
    const exists = (this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some(column => column.name === "is_timeline");
    return exists ? `${alias}is_timeline = 0` : "1";
  }

  getSessionCommitReferences(sessionId: string) {
    return new CommitStore(this.db).forSession(sessionId);
  }

  /** Read-only callers may open a store before its next schema migration. */
  private eventTimeColumn(alias = ""): string {
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    return columns.some(column => column.name === "event_at") ? `${alias}event_at` : "NULL";
  }

  private eventSourceColumn(alias = ""): string {
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    return columns.some(column => column.name === "event_time_source") ? `${alias}event_time_source` : "NULL";
  }

  /** Source bounds are requested separately so ordinary conversation reads never scan messages. */
  async getConversationTimeBounds(conversationId: ConversationId): Promise<{ firstAt: Date; lastAt: Date } | null> {
    const event = this.eventTimeColumn("m.");
    const row = this.db.prepare(`SELECT
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(MIN(julianday(${event})), MIN(julianday(m.created_at)))), c.created_at) first_at,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(MAX(julianday(${event})), MAX(julianday(m.created_at)))), c.created_at) last_at
      FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.conversation_id AND ${NOT_COMPACTION_EVENT}
      WHERE c.conversation_id = ? GROUP BY c.conversation_id`).get(conversationId) as { first_at: string; last_at: string } | undefined;
    return row ? { firstAt: parseSqliteDate(row.first_at), lastAt: parseSqliteDate(row.last_at) } : null;
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Conversation operations ───────────────────────────────────────────────

  private async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    if (input.sessionId === TIMELINE_SESSION_ID) throw new Error("Reserved project timeline session");
    const result = this.db
      // Every conversation opened from here on is parsed by the tagging
      // parser. Older ones keep NULL, which reads as unknown; they are never
      // re-tagged, so the marker states what is known rather than guessing.
      .prepare(
        `INSERT INTO conversations (session_id, title, role_tagging, parser_shape, parent_session_id, subagent_type, subagent_desc, opened_by_entry_id)
         VALUES (?, ?, 'tagged', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.title ?? null,
        input.parserShape ?? null,
        input.parentSessionId ?? null,
        input.subagentType ?? null,
        input.subagentDesc ?? null,
        input.openedByEntryId ?? null,
      );

    const row = this.db
      .prepare(`${CONVERSATION_SELECT_COLUMNS} FROM conversations WHERE conversation_id = ?`)
      .get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

    return toConversationRecord(row);
  }

  isWorkerExcluded(conversationId: number): boolean {
    const conversation = this.getConversationSync(conversationId);
    return Boolean(conversation && new WorkerStore(this.db).excluded(conversation.sessionId));
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    return this.getConversationSync(conversationId);
  }

  getConversationSync(conversationId: ConversationId): ConversationRecord | null {
    const row = this.db
      .prepare(`${CONVERSATION_SELECT_COLUMNS} FROM conversations WHERE conversation_id = ?`)
      .get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `${CONVERSATION_SELECT_COLUMNS}
       FROM conversations
       WHERE session_id = ? AND ${this.sessionFilter()}
       ORDER BY created_at DESC, conversation_id DESC
       LIMIT 1`,
      )
      .get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getOrCreateConversation(
    sessionId: string,
    title?: string,
    attribution?: SubagentAttributionInput,
    parserShape?: string | null,
  ): Promise<ConversationRecord> {
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      return this.backfillAttribution(existing, attribution);
    }
    return this.createConversation({ sessionId, title, parserShape, ...attribution });
  }

  /**
   * The session's conversation opened by a clear at transcript entry `entryId`, creating it
   * when no conversation carries that entry yet. A session has one conversation per clear
   * after its first; the newest is the one {@link getConversationBySessionId} returns.
   */
  async getOrOpenConversationAt(
    sessionId: string,
    entryId: string,
    attribution?: SubagentAttributionInput,
    parserShape?: string | null,
  ): Promise<ConversationRecord> {
    const row = this.db
      .prepare(`${CONVERSATION_SELECT_COLUMNS} FROM conversations WHERE session_id = ? AND opened_by_entry_id = ?`)
      .get(sessionId, entryId) as unknown as ConversationRow | undefined;
    return row ? toConversationRecord(row) : this.createConversation({ sessionId, openedByEntryId: entryId, parserShape, ...attribution });
  }

  /** A Claude count can be reused only if every conversation used today's parser. */
  async sessionHasParserShape(sessionId: string, parserShape: string): Promise<boolean> {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM conversations WHERE session_id = ? AND (parser_shape IS NULL OR parser_shape <> ?)",
    ).get(sessionId, parserShape) as { n: number };
    return row.n === 0;
  }

  /** Restamp a freshly rebuilt Claude conversation in the rebuild transaction. */
  setParserShape(conversationId: number, parserShape: string): void {
    this.db.prepare("UPDATE conversations SET parser_shape = ? WHERE conversation_id = ? AND parser_shape IS NOT ?")
      .run(parserShape, conversationId, parserShape);
  }

  /** Stamp every conversation after capture verified the session's stored prefix. */
  setSessionParserShape(sessionId: string, parserShape: string): void {
    this.db.prepare("UPDATE conversations SET parser_shape = ? WHERE session_id = ? AND parser_shape IS NOT ?")
      .run(parserShape, sessionId, parserShape);
  }

  /** Transcript messages stored across every conversation of the session; compaction's own event rows are not counted. */
  async getSessionMessageCount(sessionId: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages m
         JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE c.session_id = ? AND ${NOT_COMPACTION_EVENT}`,
      )
      .get(sessionId) as unknown as CountRow | undefined;
    return row?.count ?? 0;
  }

  /** Every conversation's transcript messages of the session, oldest conversation first, each in `seq` order; compaction's own event rows are left out. */
  async getSessionMessages(sessionId: string, offset = 0, limit = -1): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT m.message_id, m.conversation_id, m.seq, m.role, m.content, m.token_count, m.created_at, ${this.eventTimeColumn("m.")} AS event_at, ${this.eventSourceColumn("m.")} AS event_time_source
         FROM messages m
         JOIN conversations c ON c.conversation_id = m.conversation_id
         WHERE c.session_id = ? AND ${NOT_COMPACTION_EVENT}
         ORDER BY c.created_at, c.conversation_id, m.seq LIMIT ? OFFSET ?`,
      )
      .all(sessionId, limit, offset) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  /** Keyset pages retain session order across clears without sorting or rereading message prefixes. */
  async *sessionMessagePages(sessionId: string, limit: number): AsyncGenerator<MessageRecord[]> {
    const conversations = this.db.prepare(`SELECT conversation_id FROM conversations WHERE session_id = ?
      ORDER BY created_at, conversation_id`).all(sessionId) as Array<{ conversation_id: number }>;
    const page = this.db.prepare(`SELECT m.message_id, m.conversation_id, m.seq, m.role, m.content, m.token_count,
      m.created_at, ${this.eventTimeColumn("m.")} AS event_at, ${this.eventSourceColumn("m.")} AS event_time_source FROM messages m
      WHERE m.conversation_id = ? AND m.seq > ? AND ${NOT_COMPACTION_EVENT} ORDER BY m.seq LIMIT ?`);
    for (const conversation of conversations) {
      let seq = -1;
      for (;;) {
        const rows = page.all(conversation.conversation_id, seq, limit) as unknown as MessageRow[];
        if (rows.length) yield rows.map(toMessageRecord);
        if (rows.length < limit) break;
        seq = rows.at(-1)!.seq;
      }
    }
  }

  /** Fill unknown event times without changing capture timestamps or an earlier repair. */
  backfillMessageEventTimes(rows: ReadonlyArray<{ messageId: number; content: string; role: MessageRole; eventAt: string }>): number {
    const update = this.db.prepare("UPDATE messages SET event_at = ?, event_time_source = 'transcript' WHERE message_id = ? AND (event_at IS NULL OR event_time_source = 'commit') AND content = ? AND role = ?");
    let updated = 0;
    for (const row of rows) updated += Number(update.run(row.eventAt, row.messageId, row.content, row.role).changes);
    return updated;
  }

  /** Rewrite only verified historical NUL-cut rows and their full-text entries as one unit. */
  repairCutMessageContent(rows: ReadonlyArray<{ messageId: number; storedContent: string; content: string; eventAt?: string }>): number {
    if (rows.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE messages SET content = ?, event_time_source = CASE WHEN event_at IS NULL AND ? IS NOT NULL THEN 'transcript' ELSE event_time_source END, event_at = COALESCE(event_at, ?) WHERE message_id = ? AND
       (content = ? OR (instr(content, char(0)) > 0 AND substr(content, 1, instr(content, char(0)) - 1) = ?))`,
    );
    const timelineTracking = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'timeline_state'").get()
      && Boolean((this.db.prepare("SELECT tracking FROM timeline_state WHERE id = 1").get() as { tracking: number })?.tracking);
    const markDirty = timelineTracking ? this.db.prepare(`INSERT INTO timeline_dirty(session_id, rev)
      SELECT c.session_id, 1 FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id WHERE m.message_id = ?
      ON CONFLICT(session_id) DO UPDATE SET rev = rev + 1, dirty = 1, bumped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`) : undefined;
    const hasFts = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get() !== undefined;
    const removeFts = hasFts ? this.db.prepare("DELETE FROM messages_fts WHERE rowid = ?") : undefined;
    const addFts = hasFts ? this.db.prepare("INSERT INTO messages_fts(rowid, content) VALUES (?, ?)") : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (update.run(row.content, row.eventAt ?? null, row.eventAt ?? null, row.messageId, row.storedContent, row.storedContent).changes !== 1) {
          throw new Error(`cut message ${row.messageId} changed before repair`);
        }
        markDirty?.run(row.messageId);
        removeFts?.run(row.messageId);
        addFts?.run(row.messageId, row.content);
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Cheap identity check for a validated prefix: stream raw rows, without hydration or redaction. */
  async getSessionPrefixFingerprint(sessionId: string, count: number): Promise<string> {
    const hash = createHash("sha256");
    const databases = this.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
    const file = databases.find((entry) => entry.name === "main")!.file;
    if (file) {
      const stat = statSync(file);
      hash.update(JSON.stringify([file, stat.dev, stat.ino]));
    } else {
      if (!memoryDatabaseIds.has(this.db)) memoryDatabaseIds.set(this.db, randomUUID());
      hash.update(memoryDatabaseIds.get(this.db)!);
    }
    // Conversation identity/order/parser changes invalidate even when the message count stays put.
    for (const row of this.db.prepare(
      "SELECT conversation_id, created_at, role_tagging, parser_shape FROM conversations WHERE session_id = ? ORDER BY created_at, conversation_id",
    ).iterate(sessionId)) hash.update(JSON.stringify(row));
    for (const row of this.db.prepare(
      `SELECT m.message_id, m.conversation_id, m.seq, m.role, m.content
       FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.session_id = ? AND ${NOT_COMPACTION_EVENT}
       ORDER BY c.created_at, c.conversation_id, m.seq LIMIT ?`,
    ).iterate(sessionId, count)) hash.update(JSON.stringify(row));
    return hash.digest("hex");
  }

  /**
   * Whether compaction has written its event rows into the session while every conversation of
   * it carries role tagging — the state in which stored history must be the current transcript's
   * prefix. A conversation from before role tagging cannot
   * be compared with a fresh parse of its transcript.
   */
  async sessionComparableAfterCompaction(sessionId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
                   WHERE c.session_id = ? AND NOT ${NOT_COMPACTION_EVENT}) AS compacted,
           EXISTS (SELECT 1 FROM conversations WHERE session_id = ? AND role_tagging IS NULL) AS untagged`,
      )
      .get(sessionId, sessionId) as unknown as { compacted: number; untagged: number };
    return row.compacted === 1 && row.untagged === 0;
  }

  /**
   * Fills a still-null attribution on an already-created row — the row was
   * captured before its `.meta.json` sidecar existed, or before whichever
   * caller passed attribution ran. Guarded by `parent_session_id IS NULL` so
   * a later read of an all-null sidecar can never clobber a row already
   * correctly attributed.
   */
  private backfillAttribution(existing: ConversationRecord, attribution?: SubagentAttributionInput): ConversationRecord {
    if (!attribution?.parentSessionId || existing.parentSessionId !== null) {
      return existing;
    }
    this.db
      .prepare(
        `UPDATE conversations
       SET parent_session_id = ?, subagent_type = ?, subagent_desc = ?
       WHERE conversation_id = ? AND parent_session_id IS NULL`,
      )
      .run(attribution.parentSessionId, attribution.subagentType ?? null, attribution.subagentDesc ?? null, existing.conversationId);

    return this.getConversationSync(existing.conversationId) ?? existing;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = this.db
      .prepare(
        `${CONVERSATION_SELECT_COLUMNS}
       FROM conversations WHERE ${this.sessionFilter()}
       ORDER BY created_at`,
      )
      .all() as unknown as ConversationRow[];
    return rows.map(toConversationRecord);
  }

  /**
   * The conversation with the latest user/assistant message or summary,
   * leaving out the named session: what a session that has captured nothing
   * yet is shown in its place.
   */
  async latestActiveConversation(excludingSessionId: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `${CONVERSATION_SELECT_COLUMNS.replaceAll("conversations.", "c.")}
       FROM conversations c
       WHERE c.session_id != ? AND ${this.sessionFilter("c.")}
         AND (EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = c.conversation_id AND m.role IN ('user', 'assistant')
         ) OR EXISTS (
           SELECT 1 FROM summaries s WHERE s.conversation_id = c.conversation_id
         ))
       ORDER BY MAX(
         COALESCE((
           SELECT MAX(julianday(m.created_at)) FROM messages m
           WHERE m.conversation_id = c.conversation_id
             AND m.role IN ('user', 'assistant')
         ), -1),
         COALESCE((
           SELECT MAX(julianday(s.created_at)) FROM summaries s
           WHERE s.conversation_id = c.conversation_id
         ), -1)
       ) DESC, c.conversation_id DESC
       LIMIT 1`,
      )
      .get(excludingSessionId) as unknown as ConversationRow | undefined;
    return row ? toConversationRecord(row) : null;
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, event_at, event_time_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.conversationId, input.seq, input.role, input.content, input.tokenCount, input.eventAt?.toISOString() ?? null, input.eventAt ? "transcript" : null);

    const messageId = Number(result.lastInsertRowid);

    this.indexMessageForFullText(messageId, input.content);

    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow;

    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, event_at, event_time_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectStmt = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
       FROM messages WHERE message_id = ?`,
    );

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      const result = insertStmt.run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        input.eventAt?.toISOString() ?? null,
        input.eventAt ? "transcript" : null,
      );

      const messageId = Number(result.lastInsertRowid);
      this.indexMessageForFullText(messageId, input.content);
      const row = selectStmt.get(messageId) as unknown as MessageRow;
      records.push(toMessageRecord(row));
    }

    return records;
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = this.db
        .prepare(
          `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
        )
        .all(conversationId, afterSeq, limit) as unknown as MessageRow[];
      return rows.map(toMessageRecord);
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    return this.getMessageByIdSync(messageId);
  }

  getMessageByIdSync(messageId: MessageId): MessageRecord | null {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO message_parts (
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const part of parts) {
      stmt.run(
        randomUUID(),
        messageId,
        part.sessionId,
        part.partType,
        part.ordinal,
        part.textContent ?? null,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput ?? null,
        part.toolOutput ?? null,
        part.metadata ?? null,
      );
    }
  }

  /** Messages in one conversation, or in session conversations when none is named. */
  async getMessageCount(conversationId?: ConversationId): Promise<number> {
    const row = (
      conversationId == null
        ? this.db.prepare((this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some(column => column.name === "is_timeline")
          ? "SELECT (SELECT COUNT(*) FROM messages) - (SELECT COUNT(*) FROM messages WHERE conversation_id = (SELECT conversation_id FROM conversations WHERE is_timeline = 1)) AS count"
          : "SELECT COUNT(*) AS count FROM messages").get()
        : this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`).get(conversationId)
    ) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxSeqRow;
    return row?.max_seq ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  searchMessagesSync(input: MessageSearchInput): MessageSearchResult[] {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      if (this.fts5Available) {
        try {
          return this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
            input.terms,
            input.summaryId,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
            input.summaryId,
          );
        }
      }
      return this.searchLike(input.query, limit, input.conversationId, input.since, input.before, input.summaryId);
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before, input.summaryId);
  }

  private indexMessageForFullText(messageId: MessageId, content: string): void {
    if (!this.fts5Available) {
      return;
    }
    try {
      this.db
        .prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`)
        .run(messageId, content);
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    terms?: readonly string[],
    summaryId?: string,
  ): MessageSearchResult[] {
    // Natural-language questions ANDed term-by-term almost never match, so
    // prepare the query first: drop stopwords, then take AND matches (precise),
    // fill the remaining candidate slots with OR matches ranked by BM25 (the
    // grep baseline behavior), then fall back to a substring LIKE scan when
    // the question's vocabulary does not overlap the corpus at all.
    const prepared = prepareFts5Query(query, terms);
    if (!prepared) {
      return [];
    }
    const rows = this.runFullTextMatch(prepared.and, limit, conversationId, since, before, summaryId);
    if (!shouldRetryWithLike(prepared)) {
      return rows;
    }
    if (rows.length < limit) {
      const seen = new Set(rows.map((row) => row.messageId));
      for (const row of this.runFullTextMatch(prepared.or, limit, conversationId, since, before, summaryId)) {
        if (rows.length >= limit) break;
        if (!seen.has(row.messageId)) rows.push(row);
      }
    }
    if (rows.length > 0) {
      return rows;
    }
    return this.searchLikeTerms(prepared, limit, conversationId, since, before, summaryId);
  }

  private runFullTextMatch(
    ftsExpression: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): MessageSearchResult[] {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [ftsExpression];
    if (summaryId !== undefined) {
      where.push(`m.message_id IN (SELECT message_id FROM summary_messages WHERE summary_id IN (${SUMMARY_SOURCE_IDS_SQL}))`);
      args.push(summaryId);
    }
    if (conversationId != null) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(m.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(m.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         rank,
         m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as MessageSearchRow[];
    return byRankThenNewest(rows.map(toSearchResult));
  }

  /** Substring scan OR-ing the prepared terms (vocabulary-mismatch fallback). */
  private searchLikeTerms(
    prepared: Fts5PreparedQuery,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): MessageSearchResult[] {
    const plan = likePlanForPreparedQuery("content", prepared);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [`(${plan.where.join(" OR ")})`];
    const args: Array<string | number> = [...plan.args];
    if (summaryId !== undefined) {
      where.push(`message_id IN (SELECT message_id FROM summary_messages WHERE summary_id IN (${SUMMARY_SOURCE_IDS_SQL}))`);
      args.push(summaryId);
    }
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
         FROM messages
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseSqliteDate(row.created_at),
      rank: 0,
    }));
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): MessageSearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    if (summaryId !== undefined) {
      where.push(`message_id IN (SELECT message_id FROM summary_messages WHERE summary_id IN (${SUMMARY_SOURCE_IDS_SQL}))`);
      args.push(summaryId);
    }
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseSqliteDate(row.created_at),
      rank: 0,
    }));
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    const re = validateRegex(pattern);

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (summaryId !== undefined) {
      where.push(`message_id IN (SELECT message_id FROM summary_messages WHERE summary_id IN (${SUMMARY_SOURCE_IDS_SQL}))`);
      args.push(summaryId);
    }
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, ${this.eventTimeColumn()} AS event_at, ${this.eventSourceColumn()} AS event_time_source
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as MessageRow[];

    const results: MessageSearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          createdAt: parseSqliteDate(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }
}
