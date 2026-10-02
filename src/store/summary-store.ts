import { CommitStore } from "./commit-store.js";
import { yieldToEventLoop } from "../daemon/project-queue.js";
import { SUMMARY_SOURCE_IDS_SQL } from "./summary-lineage.js";
import { WorkerStore } from "./worker-store.js";
import type { DatabaseSync } from "node:sqlite";
import { parseSqliteDate } from "../db/sqlite-date.js";
import {
  byRankThenNewest,
  prepareFts5Query,
  shouldRetryWithLike,
  likePlanForPreparedQuery,
  type Fts5PreparedQuery,
} from "./fts5-query.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";
import { validateRegex } from "./regex-safety.js";

const TIME_BOUNDS_PAGE_SIZE = 128;
const CONTEXT_PAGE_SIZE = 128;

export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";

export type CreateSummaryInput = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth?: number;
  content: string;
  tokenCount: number;
  fileIds?: string[];
  earliestAt?: Date;
  latestAt?: Date;
  hasEventTime?: boolean;
  descendantCount?: number;
  descendantTokenCount?: number;
  sourceMessageTokenCount?: number;
};

export type SummaryRecord = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  fileIds: string[];
  earliestAt: Date | null;
  latestAt: Date | null;
  hasEventTime: boolean;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  createdAt: Date;
};

export type SummarySubtreeNodeRecord = SummaryRecord & {
  depthFromRoot: number;
  parentSummaryId: string | null;
  path: string;
  childCount: number;
};

export type ContextItemRecord = {
  conversationId: number;
  ordinal: number;
  itemType: ContextItemType;
  messageId: number | null;
  summaryId: string | null;
  createdAt: Date;
};

/** One item of the context as a restore reads it: the text, and who said it when it is a message. */
export type ContextWindowItem = {
  summaryId: string | null;
  ordinal: number;
  itemType: ContextItemType;
  role: "user" | "assistant" | "tool" | "system" | null;
  content: string;
  messageId?: number | null;
  seq?: number | null;
};

export type ContextCoverage = {
  capturedMessageIds: number[];
  renderedMessageIds: number[];
  summaryCoverage: { summaryId: string; messageIds: number[] }[];
  uncoveredMessageIds: number[];
  valid: boolean;
};

export type SummarySearchInput = {
  summaryId?: string;
  conversationId?: number;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
  /** Terms a caller already extracted (a pivot-query union); re-extracting the string would lose them. */
  terms?: readonly string[];
};

export type SummarySearchResult = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

export type LargeFileRecord = {
  fileId: string;
  conversationId: number;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  storageUri: string;
  explorationSummary: string | null;
  createdAt: Date;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  token_count: number;
  file_ids: string;
  earliest_at: string | null;
  latest_at: string | null;
  has_event_time: number;
  descendant_count: number | null;
  descendant_token_count: number | null;
  source_message_token_count: number | null;
  created_at: string;
}

interface SummarySubtreeRow extends SummaryRow {
  depth_from_root: number;
  parent_summary_id: string | null;
  path: string;
  child_count: number | null;
}

interface ContextItemRow {
  conversation_id: number;
  ordinal: number;
  item_type: ContextItemType;
  message_id: number | null;
  summary_id: string | null;
  created_at: string;
}

interface ContextWindowRow {
  summary_id: string | null;
  ordinal: number;
  item_type: ContextItemType;
  role: "user" | "assistant" | null;
  content: string;
}

interface SummarySearchRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MaxOrdinalRow {
  max_ordinal: number;
}

interface DistinctDepthRow {
  depth: number;
}

interface TokenSumRow {
  total: number;
}

interface MessageIdRow {
  message_id: number;
}

interface LargeFileRow {
  file_id: string;
  conversation_id: number;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  let fileIds: string[] = [];
  try {
    fileIds = JSON.parse(row.file_ids);
  } catch {
    // ignore malformed JSON
  }
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    fileIds,
    earliestAt: row.earliest_at ? parseSqliteDate(row.earliest_at) : null,
    latestAt: row.latest_at ? parseSqliteDate(row.latest_at) : null,
    hasEventTime: row.has_event_time === 1,
    descendantCount:
      typeof row.descendant_count === "number" &&
      Number.isFinite(row.descendant_count) &&
      row.descendant_count >= 0
        ? Math.floor(row.descendant_count)
        : 0,
    descendantTokenCount:
      typeof row.descendant_token_count === "number" &&
      Number.isFinite(row.descendant_token_count) &&
      row.descendant_token_count >= 0
        ? Math.floor(row.descendant_token_count)
        : 0,
    sourceMessageTokenCount:
      typeof row.source_message_token_count === "number" &&
      Number.isFinite(row.source_message_token_count) &&
      row.source_message_token_count >= 0
        ? Math.floor(row.source_message_token_count)
        : 0,
    createdAt: parseSqliteDate(row.created_at),
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: parseSqliteDate(row.created_at),
  };
}

function toContextWindowItem(row: ContextWindowRow): ContextWindowItem {
  return { ordinal: row.ordinal, itemType: row.item_type, role: row.role, content: row.content, summaryId: row.summary_id };
}

function toSearchResult(row: SummarySearchRow): SummarySearchResult {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    snippet: row.snippet,
    createdAt: parseSqliteDate(row.created_at),
    rank: row.rank,
  };
}

function toLargeFileRecord(row: LargeFileRow): LargeFileRecord {
  return {
    fileId: row.file_id,
    conversationId: row.conversation_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageUri: row.storage_uri,
    explorationSummary: row.exploration_summary,
    createdAt: parseSqliteDate(row.created_at),
  };
}

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  getCommitReferences(summaryId: string) {
    return new CommitStore(this.db).forSummary(summaryId);
  }
  private readonly fts5Available: boolean;
  private readonly includeStale: boolean;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean; includeStale?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
    this.includeStale = options?.includeStale ?? true;
  }

  /** Covering leaf and condensed summaries for a bounded set of grep matches. */
  coveringSummaryIds(messageIds: number[]): Map<number, string[]> {
    const result = new Map<number, string[]>();
    if (messageIds.length === 0) return result;
    const rows = this.db.prepare(`
      WITH RECURSIVE coverage(message_id, summary_id) AS (
        SELECT message_id, summary_id FROM summary_messages
        WHERE message_id IN (SELECT value FROM json_each(?))
        UNION
        SELECT coverage.message_id, sp.summary_id FROM coverage
        JOIN summary_parents sp ON sp.parent_summary_id = coverage.summary_id
      )
      SELECT coverage.message_id, coverage.summary_id FROM coverage
      JOIN summaries s ON s.summary_id = coverage.summary_id
      ORDER BY s.depth, coverage.summary_id
    `).all(JSON.stringify(messageIds)) as Array<{ message_id: number; summary_id: string }>;
    for (const row of rows) {
      const ids = result.get(row.message_id) ?? [];
      ids.push(row.summary_id);
      result.set(row.message_id, ids);
    }
    return result;
  }

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  /** Summaries neither present in context nor used as source by another summary. */
  getOrphanSummaryIds(): string[] {
    const hasTimeline = (this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some(column => column.name === "is_timeline");
    const rows = this.db.prepare(`
      SELECT s.summary_id FROM summaries s
       WHERE ${hasTimeline ? "NOT EXISTS (SELECT 1 FROM conversations owner WHERE owner.conversation_id = s.conversation_id AND owner.is_timeline = 1)" : "1"}
         AND NOT EXISTS (SELECT 1 FROM context_items c WHERE c.summary_id = s.summary_id)
         AND NOT EXISTS (SELECT 1 FROM summary_parents p
           ${hasTimeline ? "JOIN summaries consumer ON consumer.summary_id = p.summary_id JOIN conversations owner ON owner.conversation_id = consumer.conversation_id" : ""}
           WHERE p.parent_summary_id = s.summary_id ${hasTimeline ? "AND owner.is_timeline = 0" : ""})
       ORDER BY s.summary_id
    `).all() as Array<{ summary_id: string }>;
    return rows.map(row => row.summary_id);
  }

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    return this.insertSummarySync(input);
  }

  insertSummarySync(input: CreateSummaryInput): SummaryRecord {
    const conversation = this.db.prepare("SELECT session_id FROM conversations WHERE conversation_id = ?").get(input.conversationId) as { session_id: string } | undefined;
    if (conversation && new WorkerStore(this.db).excluded(conversation.session_id)) throw new Error("Worker session is excluded from compaction");
    const fileIds = JSON.stringify(input.fileIds ?? []);
    const earliestAt = input.earliestAt instanceof Date ? input.earliestAt.toISOString() : null;
    const latestAt = input.latestAt instanceof Date ? input.latestAt.toISOString() : null;
    const descendantCount =
      typeof input.descendantCount === "number" &&
      Number.isFinite(input.descendantCount) &&
      input.descendantCount >= 0
        ? Math.floor(input.descendantCount)
        : 0;
    const descendantTokenCount =
      typeof input.descendantTokenCount === "number" &&
      Number.isFinite(input.descendantTokenCount) &&
      input.descendantTokenCount >= 0
        ? Math.floor(input.descendantTokenCount)
        : 0;
    const sourceMessageTokenCount =
      typeof input.sourceMessageTokenCount === "number" &&
      Number.isFinite(input.sourceMessageTokenCount) &&
      input.sourceMessageTokenCount >= 0
        ? Math.floor(input.sourceMessageTokenCount)
        : 0;
    const depth =
      typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0
        ? Math.floor(input.depth)
        : input.kind === "leaf"
          ? 0
          : 1;

    this.db
      .prepare(
        `INSERT INTO summaries (
          summary_id,
          conversation_id,
          kind,
          depth,
          content,
          token_count,
          file_ids,
          earliest_at,
          latest_at,
          has_event_time,
          descendant_count,
          descendant_token_count,
          source_message_token_count
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.summaryId,
        input.conversationId,
        input.kind,
        depth,
        input.content,
        input.tokenCount,
        fileIds,
        earliestAt,
        latestAt,
        Number(input.hasEventTime ?? false),
        descendantCount,
        descendantTokenCount,
        sourceMessageTokenCount,
      );

    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, has_event_time
       FROM summaries WHERE summary_id = ?`,
      )
      .get(input.summaryId) as unknown as SummaryRow;

    // Index in FTS5 as best-effort; compaction flow must continue even if
    // FTS indexing fails for any reason.
    if (!this.fts5Available) {
      return toSummaryRecord(row);
    }

    try {
      this.db
        .prepare(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`)
        .run(input.summaryId, input.content);
    } catch {
      // FTS indexing failed — search won't find this summary but
      // compaction and assembly will still work correctly.
    }

    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    return this.getSummarySync(summaryId);
  }

  getSummarySync(summaryId: string): SummaryRecord | null {
    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, has_event_time
       FROM summaries WHERE summary_id = ?`,
      )
      .get(summaryId) as unknown as SummaryRow | undefined;
    return row ? toSummaryRecord(row) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, has_event_time
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY created_at`,
      )
      .all(conversationId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  /** A conversation's summaries, the most condensed and then the newest first. */
  async summariesDeepestFirst(conversationId: number, limit: number): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, has_event_time
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY depth DESC, created_at DESC
       LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  /** The newest summaries across every conversation. */
  async listRecent(limit: number): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, has_event_time
       FROM summaries
       ORDER BY created_at DESC
       LIMIT ?`,
      )
      .all(limit) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  /** Known bounds from direct sources' persisted metadata, without reading their descendants. */
  getSourceEventTimeBounds(summaryIds: string[]): { earliestAt: Date; latestAt: Date } | null {
    const rows = this.db.prepare(`SELECT s.earliest_at, s.latest_at FROM summaries s
      WHERE s.summary_id IN (SELECT value FROM json_each(?)) AND s.has_event_time = 1`)
      .all(JSON.stringify(summaryIds)) as Array<{ earliest_at: string; latest_at: string }>;
    if (!rows.length) return null;
    return {
      earliestAt: new Date(Math.min(...rows.map(row => parseSqliteDate(row.earliest_at).getTime()))),
      latestAt: new Date(Math.max(...rows.map(row => parseSqliteDate(row.latest_at).getTime()))),
    };
  }

  /** Recompute leaves before their condensed descendants, yielding between bounded pages. */
  async recomputeTimeBounds(conversationId: number): Promise<void> {
    let depth = -1;
    let id = "";
    for (;;) {
      const page = this.db.prepare(`SELECT summary_id, depth, kind FROM summaries WHERE conversation_id = ?
        AND (depth, summary_id) > (?, ?) ORDER BY depth, summary_id LIMIT ${TIME_BOUNDS_PAGE_SIZE}`)
        .all(conversationId, depth, id) as Array<{ summary_id: string; depth: number; kind: SummaryKind }>;
      for (const summary of page) {
        const range = summary.kind === "leaf"
          ? this.db.prepare(`SELECT COALESCE(MIN(julianday(m.event_at)), MIN(julianday(m.created_at))) first,
              COALESCE(MAX(julianday(m.event_at)), MAX(julianday(m.created_at))) last, COUNT(m.event_at) > 0 known
              FROM summary_messages sm JOIN messages m USING(message_id) WHERE sm.summary_id = ?`).get(summary.summary_id)
          : this.db.prepare(`SELECT COALESCE(MIN(CASE WHEN s.has_event_time = 1 THEN julianday(s.earliest_at) END),
                MIN(julianday(COALESCE(s.earliest_at, s.created_at)))) first,
              COALESCE(MAX(CASE WHEN s.has_event_time = 1 THEN julianday(s.latest_at) END),
                MAX(julianday(COALESCE(s.latest_at, s.created_at)))) last, COALESCE(MAX(s.has_event_time), 0) known
              FROM summary_parents p JOIN summaries s ON s.summary_id = p.parent_summary_id WHERE p.summary_id = ?`).get(summary.summary_id);
        const bounds = range as { first: number | null; last: number | null; known: number };
        this.db.prepare(`UPDATE summaries
          SET earliest_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ?), created_at),
            latest_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ?), created_at), has_event_time = ?
          WHERE summary_id = ? AND (julianday(earliest_at) IS NOT ? OR julianday(latest_at) IS NOT ? OR has_event_time != ?)`)
          .run(bounds.first, bounds.last, bounds.known, summary.summary_id, bounds.first, bounds.last, bounds.known);
      }
      await yieldToEventLoop();
      if (page.length < TIME_BOUNDS_PAGE_SIZE) return;
      depth = page.at(-1)!.depth;
      id = page.at(-1)!.summary_id;
    }
  }

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    for (let offset = 0; offset < messageIds.length; offset += CONTEXT_PAGE_SIZE) {
      this.linkSummaryToMessagesSync(summaryId, messageIds.slice(offset, offset + CONTEXT_PAGE_SIZE), offset);
      await yieldToEventLoop();
    }
  }

  linkSummaryToMessagesSync(summaryId: string, messageIds: number[], ordinalOffset = 0): void {
    if (messageIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, message_id) DO NOTHING`,
    );

    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(summaryId, messageIds[idx], ordinalOffset + idx);
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    for (let offset = 0; offset < parentSummaryIds.length; offset += CONTEXT_PAGE_SIZE) {
      this.linkSummaryToParentsSync(summaryId, parentSummaryIds.slice(offset, offset + CONTEXT_PAGE_SIZE), offset);
      await yieldToEventLoop();
    }
  }

  linkSummaryToParentsSync(summaryId: string, parentSummaryIds: string[], ordinalOffset = 0): void {
    if (parentSummaryIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`,
    );

    for (let idx = 0; idx < parentSummaryIds.length; idx++) {
      stmt.run(summaryId, parentSummaryIds[idx], ordinalOffset + idx);
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const rows = this.db
      .prepare(
        `SELECT message_id FROM summary_messages
       WHERE summary_id = ?
       ORDER BY ordinal`,
      )
      .all(summaryId) as unknown as MessageIdRow[];
    return rows.map((r) => r.message_id);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count, s.has_event_time
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(parentSummaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count, s.has_event_time
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(summaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  async getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
           SELECT ?, NULL, 0, ''
           UNION ALL
           SELECT
             sp.parent_summary_id,
             sp.summary_id,
             subtree.depth_from_root + 1,
             CASE
               WHEN subtree.path = '' THEN printf('%04d', sp.ordinal)
               ELSE subtree.path || '.' || printf('%04d', sp.ordinal)
             END
           FROM summary_parents sp
           JOIN subtree ON sp.summary_id = subtree.summary_id
         )
         SELECT
           s.summary_id,
           s.conversation_id,
           s.kind,
           s.depth,
           s.content,
           s.token_count,
           s.file_ids,
           s.earliest_at,
           s.latest_at,
           s.descendant_count,
           s.descendant_token_count,
           s.source_message_token_count, s.has_event_time,
           s.created_at,
           subtree.depth_from_root,
           subtree.parent_summary_id,
           subtree.path,
           (
             SELECT COUNT(*) FROM summary_parents sp2
             WHERE sp2.summary_id = s.summary_id
           ) AS child_count
         FROM subtree
         JOIN summaries s ON s.summary_id = subtree.summary_id
         ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`,
      )
      .all(summaryId) as unknown as SummarySubtreeRow[];

    const seen = new Set<string>();
    const output: SummarySubtreeNodeRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.summary_id)) {
        continue;
      }
      seen.add(row.summary_id);
      output.push({
        ...toSummaryRecord(row),
        depthFromRoot: Math.max(0, Math.floor(row.depth_from_root ?? 0)),
        parentSummaryId: row.parent_summary_id ?? null,
        path: typeof row.path === "string" ? row.path : "",
        childCount:
          typeof row.child_count === "number" && Number.isFinite(row.child_count)
            ? Math.max(0, Math.floor(row.child_count))
            : 0,
      });
    }
    return output;
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number, options?: { afterOrdinal?: number }): Promise<ContextItemRecord[]> {
    const rows = this.db.prepare(
      `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items
       WHERE conversation_id = ? ${options?.afterOrdinal != null ? "AND ordinal > ?" : ""}
       ORDER BY ordinal`,
    ).all(...(options?.afterOrdinal != null ? [conversationId, options.afterOrdinal] : [conversationId])) as unknown as ContextItemRow[];
    return rows.map(toContextItemRecord);
  }

  /**
   * The end of the context as a restore replays it: the last `limit`
   * summaries and the last `limit` user/assistant messages among the context
   * items, in context order. A conversation captured before context items
   * were materialised has none; its last `limit` user/assistant messages
   * stand in, in seq order.
   */
  async readContextWindow(conversationId: number, limit: number, options: { complete?: boolean } = {}): Promise<ContextWindowItem[]> {
    if (options.complete) {
      const hasContext = this.db.prepare("SELECT 1 FROM context_items WHERE conversation_id = ? LIMIT 1").get(conversationId);
      const rows = this.db.prepare(hasContext ? `
        SELECT ci.ordinal, ci.item_type, ci.summary_id AS summaryId, m.message_id AS messageId,
               m.seq, m.role, COALESCE(m.content, s.content) AS content
        FROM context_items ci
        LEFT JOIN messages m ON ci.item_type = 'message' AND m.message_id = ci.message_id AND m.conversation_id = ci.conversation_id
        LEFT JOIN summaries s ON ci.item_type = 'summary' AND s.summary_id = ci.summary_id AND s.conversation_id = ci.conversation_id
        WHERE ci.conversation_id = ? AND COALESCE(m.content, s.content) IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
        ORDER BY ci.ordinal` : `
        SELECT m.seq AS ordinal, 'message' AS item_type, NULL AS summaryId, m.message_id AS messageId,
               m.seq, m.role, m.content FROM messages m WHERE m.conversation_id = ?
          AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
        ORDER BY m.seq`).all(conversationId) as unknown as Array<ContextWindowItem & { item_type: ContextItemType }>;
      return rows.map(({ item_type, ...row }) => ({ ...row, itemType: item_type }));
    }
    const contextRows = this.db
      .prepare(
        `WITH ranked AS (
           SELECT ci.ordinal, ci.item_type, ci.summary_id, m.role, COALESCE(m.content, s.content) AS content,
                  ROW_NUMBER() OVER (PARTITION BY ci.item_type ORDER BY ci.ordinal DESC) AS item_rank
           FROM context_items ci
           LEFT JOIN messages m ON ci.item_type = 'message' AND m.message_id = ci.message_id
           LEFT JOIN summaries s ON ci.item_type = 'summary' AND s.summary_id = ci.summary_id
           WHERE ci.conversation_id = ?
             AND ((ci.item_type = 'summary' AND s.content IS NOT NULL)
               OR (ci.item_type = 'message' AND m.role IN ('user', 'assistant') AND m.content IS NOT NULL))
         )
         SELECT ordinal, item_type, summary_id, role, content
         FROM ranked
         WHERE item_rank <= ?
         ORDER BY ordinal`,
      )
      .all(conversationId, limit) as unknown as ContextWindowRow[];
    if (contextRows.length > 0) return contextRows.map(toContextWindowItem);

    const messageRows = this.db
      .prepare(
        `SELECT seq AS ordinal, 'message' AS item_type, NULL AS summary_id, role, content
         FROM messages
         WHERE conversation_id = ? AND role IN ('user', 'assistant')
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as ContextWindowRow[];
    return messageRows.reverse().map(toContextWindowItem);
  }

  /** Exact source coverage of complete rendered items; malformed lineage never proves coverage. */
  async readContextCoverage(conversationId: number, items: readonly ContextWindowItem[]): Promise<ContextCoverage> {
    const capturedMessageIds = (this.db.prepare(`SELECT m.message_id FROM messages m WHERE m.conversation_id = ?
      AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
      ORDER BY m.seq`).all(conversationId) as { message_id: number }[]).map(r => r.message_id);
    const captured = new Set(capturedMessageIds);
    const activeRoots = new Set((await this.getContextItems(conversationId)).map(i => i.summaryId).filter(Boolean));
    const parents = this.db.prepare("SELECT parent_summary_id FROM summary_parents WHERE summary_id = ? ORDER BY ordinal");
    const messages = this.db.prepare("SELECT message_id FROM summary_messages WHERE summary_id = ? ORDER BY ordinal");
    const memo = new Map<string, Set<number>>();
    const visiting = new Set<string>();
    const renderedRoots = new Set(items.filter(i => i.itemType === "summary").map(i => i.summaryId));
    const dangling = this.db.prepare(`SELECT 1 FROM context_items ci WHERE ci.conversation_id = ? AND (
      (ci.item_type = 'message' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.message_id = ci.message_id AND m.conversation_id = ci.conversation_id)) OR
      (ci.item_type = 'summary' AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.summary_id = ci.summary_id AND s.conversation_id = ci.conversation_id))) LIMIT 1`).get(conversationId);
    let valid = !dangling && [...activeRoots].every(id => renderedRoots.has(id));
    const visit = async (id: string): Promise<Set<number>> => {
      if (visiting.has(id)) { valid = false; return new Set(); }
      const known = memo.get(id);
      if (known) return known;
      const summary = await this.getSummary(id);
      if (!summary || !summary.content.trim() || summary.conversationId !== conversationId) { valid = false; return new Set(); }
      visiting.add(id);
      const source = new Set((messages.all(id) as { message_id: number }[]).map(r => r.message_id));
      if ([...source].some(messageId => !captured.has(messageId))) valid = false;
      const parentIds = (parents.all(id) as { parent_summary_id: string }[]).map(r => r.parent_summary_id);
      if (source.size === 0 && parentIds.length === 0) valid = false;
      for (const parentId of parentIds) for (const messageId of await visit(parentId)) source.add(messageId);
      visiting.delete(id);
      memo.set(id, source);
      await yieldToEventLoop();
      return source;
    };
    const renderedMessageIds = items.flatMap(i => i.itemType === "message" && i.messageId != null ? [i.messageId] : []);
    if (renderedMessageIds.some(id => !captured.has(id))) valid = false;
    const covered = new Set(renderedMessageIds);
    const summaryCoverage: ContextCoverage["summaryCoverage"] = [];
    for (const item of items) {
      if (item.itemType !== "summary" || !item.summaryId) continue;
      if (!activeRoots.has(item.summaryId)) valid = false;
      const ids = [...await visit(item.summaryId)].sort((a, b) => a - b);
      summaryCoverage.push({ summaryId: item.summaryId, messageIds: ids });
      for (const id of ids) covered.add(id);
    }
    return { capturedMessageIds, renderedMessageIds, summaryCoverage,
      uncoveredMessageIds: capturedMessageIds.filter(id => !covered.has(id)), valid };
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const maxOrdinalExclusive = options?.maxOrdinalExclusive;
    const useOrdinalBound =
      typeof maxOrdinalExclusive === "number" &&
      Number.isFinite(maxOrdinalExclusive) &&
      maxOrdinalExclusive !== Infinity;

    const sql = useOrdinalBound
      ? `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
           AND ci.ordinal < ?
         ORDER BY s.depth ASC`
      : `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
         ORDER BY s.depth ASC`;

    const rows = useOrdinalBound
      ? (this.db
          .prepare(sql)
          .all(conversationId, Math.floor(maxOrdinalExclusive)) as unknown as DistinctDepthRow[])
      : (this.db.prepare(sql).all(conversationId) as unknown as DistinctDepthRow[]);

    return rows.map((row) => row.depth);
  }

  /** How many summaries a conversation holds, or session summaries when none is named. */
  async countSummaries(conversationId?: number): Promise<number> {
    const row = (
      conversationId == null
        ? this.db.prepare((this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).some(column => column.name === "is_timeline")
          ? "SELECT (SELECT COUNT(*) FROM summaries) - (SELECT COUNT(*) FROM summaries WHERE conversation_id = (SELECT conversation_id FROM conversations WHERE is_timeline = 1)) AS n"
          : "SELECT COUNT(*) AS n FROM summaries").get()
        : this.db.prepare(`SELECT COUNT(*) AS n FROM summaries WHERE conversation_id = ?`).get(conversationId)
    ) as unknown as { n: number };
    return row.n;
  }

  /**
   * Drop every summary in a conversation and rebuild context_items from its
   * messages, in seq order.
   *
   * This is sound because context_items is a derived view: compaction only
   * rewrites it, never deletes messages, so nothing is lost that cannot be
   * re-derived. Callers use it to undo compaction wholesale rather than
   * unpicking individual summaries.
   *
   * Compaction-event messages are dropped and excluded from the rebuild — they
   * describe summaries that no longer exist, and have never been context items.
   *
   * Returns the number of summaries removed.
   */
  async resetConversationContext(conversationId: number): Promise<number> {
    this.db.exec("BEGIN");
    try {
      const summaryRows = this.db
        .prepare(`SELECT summary_id FROM summaries WHERE conversation_id = ?`)
        .all(conversationId) as unknown as { summary_id: string }[];
      const summaryIds = summaryRows.map((row) => row.summary_id);

      if (summaryIds.length > 0) {
        const placeholders = summaryIds.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM summary_messages WHERE summary_id IN (${placeholders})`)
          .run(...summaryIds);
        this.db
          .prepare(
            `DELETE FROM summary_parents
             WHERE summary_id IN (${placeholders})
                OR parent_summary_id IN (${placeholders})`,
          )
          .run(...summaryIds, ...summaryIds);
      }

      this.db.prepare(`DELETE FROM context_items WHERE conversation_id = ?`).run(conversationId);
      this.db.prepare(`DELETE FROM summaries WHERE conversation_id = ?`).run(conversationId);

      // Compaction events narrate summaries that are now gone.
      const eventRows = this.db
        .prepare(
          `SELECT m.message_id FROM messages m
           WHERE m.conversation_id = ?
             AND EXISTS (
               SELECT 1 FROM message_parts p
               WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
             )`,
        )
        .all(conversationId) as unknown as { message_id: number }[];
      const eventMessageIds = eventRows.map((row) => row.message_id);

      if (eventMessageIds.length > 0) {
        const placeholders = eventMessageIds.map(() => "?").join(", ");
        this.db
          .prepare(`DELETE FROM messages WHERE message_id IN (${placeholders})`)
          .run(...eventMessageIds);
      }

      // The predicate is redundant after the delete above, and deliberately
      // kept: this statement must stay correct on its own.
      this.db
        .prepare(
          `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
           SELECT ?, ROW_NUMBER() OVER (ORDER BY m.seq) - 1, 'message', m.message_id
           FROM messages m
           WHERE m.conversation_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM message_parts p
               WHERE p.message_id = m.message_id AND p.part_type = 'compaction'
             )
           ORDER BY m.seq`,
        )
        .run(conversationId, conversationId);

      this.db.exec("COMMIT");

      // Best-effort, and outside the transaction: a stale FTS row makes search
      // return a dead id, it does not corrupt context.
      if (this.fts5Available) {
        if (summaryIds.length > 0) {
          const placeholders = summaryIds.map(() => "?").join(", ");
          try {
            this.db
              .prepare(`DELETE FROM summaries_fts WHERE summary_id IN (${placeholders})`)
              .run(...summaryIds);
          } catch {
            // FTS cleanup failed — search may surface removed summaries.
          }
        }
        if (eventMessageIds.length > 0) {
          const placeholders = eventMessageIds.map(() => "?").join(", ");
          try {
            this.db
              .prepare(`DELETE FROM messages_fts WHERE rowid IN (${placeholders})`)
              .run(...eventMessageIds);
          } catch {
            // FTS cleanup failed — search may surface removed event messages.
          }
        }
      }

      return summaryIds.length;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;
    const baseOrdinal = row.max_ordinal + 1;

    const stmt = this.db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`,
    );
    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(conversationId, baseOrdinal + idx, messageIds[idx]);
    }
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    this.db.exec("BEGIN");
    try {
      // 1. Delete context items in the range [startOrdinal, endOrdinal]
      this.db
        .prepare(
          `DELETE FROM context_items
         WHERE conversation_id = ?
           AND ordinal >= ?
           AND ordinal <= ?`,
        )
        .run(conversationId, startOrdinal, endOrdinal);

      // 2. Insert the replacement summary item at startOrdinal
      this.db
        .prepare(
          `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (?, ?, 'summary', ?)`,
        )
        .run(conversationId, startOrdinal, summaryId);

      // 3. Resequence to contiguous ordinals 0..n-1 in two set-based statements. The
      //    transaction stays synchronous: a yield here would expose it to other requests
      //    on this pooled connection. Negating first keeps every ordinal unique.
      this.db.prepare("UPDATE context_items SET ordinal = -1 - ordinal WHERE conversation_id = ?").run(conversationId);
      this.db.prepare(`UPDATE context_items SET ordinal = ranked.position
        FROM (SELECT ordinal AS negated, ROW_NUMBER() OVER (ORDER BY ordinal DESC) - 1 AS position
              FROM context_items WHERE conversation_id = ?) AS ranked
        WHERE context_items.conversation_id = ? AND context_items.ordinal = ranked.negated`)
        .run(conversationId, conversationId);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_count), 0) AS total
       FROM (
         SELECT m.token_count
         FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'message'

         UNION ALL

         SELECT s.token_count
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
       ) sub`,
      )
      .get(conversationId, conversationId) as unknown as TokenSumRow;
    return row?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  searchSummariesSync(input: SummarySearchInput): SummarySearchResult[] {
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

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    terms?: readonly string[],
    summaryId?: string,
  ): SummarySearchResult[] {
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
      const seen = new Set(rows.map((row) => row.summaryId));
      for (const row of this.runFullTextMatch(prepared.or, limit, conversationId, since, before, summaryId)) {
        if (rows.length >= limit) break;
        if (!seen.has(row.summaryId)) rows.push(row);
      }
    }
    if (rows.length > 0) {
      return rows;
    }
    return this.searchLikeTerms(prepared, limit, conversationId, since, before, summaryId);
  }

  private timelinePredicate(column = "summary_id"): string[] {
    return this.includeStale ? [] : [`NOT EXISTS (SELECT 1 FROM timeline_nodes tn WHERE tn.summary_id = ${column} AND tn.stale_reason IS NOT NULL)`];
  }

  private runFullTextMatch(
    ftsExpression: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): SummarySearchResult[] {
    const where: string[] = ["summaries_fts MATCH ?", ...this.timelinePredicate("s.summary_id")];
    const args: Array<string | number> = [ftsExpression];
    if (summaryId !== undefined) {
      where.push(`s.summary_id IN (${SUMMARY_SOURCE_IDS_SQL})`);
      args.push(summaryId);
    }
    if (conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(s.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(s.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         summaries_fts.summary_id,
         s.conversation_id,
         s.kind,
         snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
         rank,
         s.created_at
       FROM summaries_fts
       JOIN summaries s ON s.summary_id = summaries_fts.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as SummarySearchRow[];
    return byRankThenNewest(rows.map(toSearchResult));
  }

  /** Substring scan OR-ing the prepared terms (vocabulary-mismatch fallback). */
  private searchLikeTerms(
    prepared: Fts5PreparedQuery,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): SummarySearchResult[] {
    const plan = likePlanForPreparedQuery("content", prepared);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [`(${plan.where.join(" OR ")})`, ...this.timelinePredicate("summaries.summary_id")];
    const args: Array<string | number> = [...plan.args];
    if (summaryId !== undefined) {
      where.push(`summary_id IN (${SUMMARY_SOURCE_IDS_SQL})`);
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
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, has_event_time, created_at
         FROM summaries
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as SummaryRow[];

    return rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseSqliteDate(row.created_at),
      rank: 0,
    }));
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): SummarySearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where, ...this.timelinePredicate("summaries.summary_id")];
    const args: Array<string | number> = [...plan.args];
    if (summaryId !== undefined) {
      where.push(`summary_id IN (${SUMMARY_SOURCE_IDS_SQL})`);
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
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, has_event_time, created_at
         FROM summaries
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as SummaryRow[];

    return rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseSqliteDate(row.created_at),
      rank: 0,
    }));
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    summaryId?: string,
  ): SummarySearchResult[] {
    const re = validateRegex(pattern);

    const where: string[] = [...this.timelinePredicate("summaries.summary_id")];
    const args: Array<string | number> = [];
    if (summaryId !== undefined) {
      where.push(`summary_id IN (${SUMMARY_SOURCE_IDS_SQL})`);
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
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, has_event_time, created_at
         FROM summaries
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as SummaryRow[];

    const results: SummarySearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind,
          snippet: match[0],
          createdAt: parseSqliteDate(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const row = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
      )
      .get(fileId) as unknown as LargeFileRow | undefined;
    return row ? toLargeFileRecord(row) : null;
  }
}
