import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseSqliteDate } from "../db/sqlite-date.js";
import { parseStoredTags } from "../db/votes.js";
import { yieldToEventLoop } from "../daemon/project-queue.js";
import { SummaryStore } from "../store/summary-store.js";

export type TimeBasis = "event" | "capture" | "mixed";

export type Coverage = {
  timeBasis?: TimeBasis;
  conversationId: number; sessionId: string; revision: string;
  summaryIds: string[]; messageIds: number[]; messageRange?: [number, number];
};
export type Item = {
  id: string; content: string; tokens: number; from: string; to: string;
  summaryId?: string; messageId?: number; seq?: number; coverage: Coverage[];
  position?: number; depth: number;
  hasEventTime?: boolean;
  sourceTokens: number; descendantCount: number; descendantTokens: number;
};
export type Memory = { memoryId: string; revision: string; content: string; createdAt: string };
export type Work = {
  key: string; level: "digest" | "period"; items: Item[]; coverage: Coverage[];
  from: string; to: string; memories: Memory[]; generator: string;
};
type Message = { message_id: number; seq: number; content: string; role: string; token_count: number; created_at: string; event_at: string | null };
type Summary = { summary_id: string; content: string; token_count: number; earliest_at: string | null; latest_at: string | null; created_at: string; depth: number; source_message_token_count: number; descendant_count: number; descendant_token_count: number };

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const iso = (date: string) => parseSqliteDate(date).toISOString();

export type Input = { conversationId: number; sessionId: string; revision: string; items: Item[] };

/** Each read releases its cursor before yielding; no mutation lease encloses source scans. */
export async function readRows<T>(db: DatabaseSync, sql: string, args: Array<string | number> = [], key?: string): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  let cursor: string | number = key === "summary_id" || key === "id" ? "" : -1;
  for (;;) {
    const batch = (key
      ? db.prepare(`SELECT * FROM (${sql}) WHERE ${key} > ? ORDER BY ${key} LIMIT 256`).all(...args, cursor)
      : db.prepare(`SELECT * FROM (${sql}) LIMIT 256 OFFSET ?`).all(...args, offset)) as T[];
    rows.push(...batch);
    await yieldToEventLoop();
    if (batch.length < 256) return rows;
    offset += batch.length;
    if (key) cursor = (batch.at(-1) as Record<string, string | number>)[key];
  }
}

/** Graph frontier ignores the synthetic owner's incoming references. */
export async function readItems(db: DatabaseSync, sessionId: string): Promise<Input[]> {
  const conversations = await readRows<{ conversation_id: number; session_id: string }>(db,
    "SELECT conversation_id, session_id FROM conversations WHERE is_timeline = 0 AND session_id = ? ORDER BY created_at, conversation_id", [sessionId]);
  let messageOffset = 0;
  const inputs: Input[] = [];
  for (const conversation of conversations) {
    const result = await conversationItems(db, { ...conversation, messageOffset });
    inputs.push({ conversationId: conversation.conversation_id, sessionId, revision: result.revision, items: result.items });
    messageOffset += result.messageCount;
  }
  return inputs;
}

export const REMAINDER_SQL = `SELECT m.message_id, m.seq, m.content, m.role, m.token_count, m.created_at, m.event_at
  FROM messages m WHERE m.conversation_id = ? AND NOT EXISTS
    (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')
  AND NOT EXISTS (SELECT 1 FROM summary_messages sm JOIN summaries s ON s.summary_id = sm.summary_id
    WHERE sm.message_id = m.message_id AND s.conversation_id = m.conversation_id) ORDER BY m.seq`;
export const FRONTIER_SQL = `SELECT s.summary_id, s.content, s.token_count, s.earliest_at, s.latest_at, s.created_at, s.depth,
  s.source_message_token_count, s.descendant_count, s.descendant_token_count
  FROM summaries s WHERE s.conversation_id = ? AND NOT EXISTS (
    SELECT 1 FROM summary_parents p JOIN summaries child ON child.summary_id = p.summary_id
    WHERE p.parent_summary_id = s.summary_id AND child.conversation_id = s.conversation_id) ORDER BY s.summary_id`;

async function conversationItems(db: DatabaseSync, conversation: { conversation_id: number; session_id: string; messageOffset: number }): Promise<{ items: Item[]; messageCount: number; revision: string }> {
  const id = conversation.conversation_id;
  const summaries = await readRows<Summary>(db, FRONTIER_SQL, [id], "summary_id");
  const messages = await readRows<Message>(db, REMAINDER_SQL, [id], "seq");
  const count = db.prepare(`SELECT COUNT(*) n, COUNT(m.event_at) known FROM messages m WHERE m.conversation_id = ? AND NOT EXISTS
    (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')`).get(id) as { n: number; known: number };
  const revision = hash([conversation.session_id, conversation.messageOffset, summaries, messages, count.known]);
  const timeBasis: TimeBasis = count.known === 0 ? "capture" : count.known === count.n ? "event" : "mixed";
  const base = { conversationId: id, sessionId: conversation.session_id, revision, timeBasis };
  const store = new SummaryStore(db);
  const items: Item[] = summaries.map(summary => {
    const known = store.getSourceEventTimeBounds([summary.summary_id]);
    return {
      id: summary.summary_id, summaryId: summary.summary_id, content: summary.content,
      tokens: summary.token_count, from: known?.earliestAt.toISOString() ?? iso(summary.earliest_at ?? summary.created_at),
      to: known?.latestAt.toISOString() ?? iso(summary.latest_at ?? summary.created_at), depth: summary.depth,
      hasEventTime: known !== null,
      sourceTokens: summary.source_message_token_count, descendantCount: summary.descendant_count, descendantTokens: summary.descendant_token_count,
      coverage: [{ ...base, summaryIds: [summary.summary_id], messageIds: [] }],
    };
  });
  // Disjoint gaps preserve transcript positions without repeatedly counting the entire prefix.
  let previousSeq = -1;
  let position = -1;
  const gap = db.prepare(`SELECT COUNT(*) n FROM messages m WHERE m.conversation_id = ? AND m.seq > ? AND m.seq < ?
    AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.message_id AND p.part_type = 'compaction')`);
  for (const message of messages) {
    position += (gap.get(id, previousSeq, message.seq) as { n: number }).n + 1;
    previousSeq = message.seq;
    const at = conversation.messageOffset + position;
    items.push({ id: `msg_${message.message_id}`, messageId: message.message_id, seq: message.seq,
      content: `[${message.role}] ${message.content}`, tokens: message.token_count,
      from: iso(message.event_at ?? message.created_at), to: iso(message.event_at ?? message.created_at), depth: 0,
      hasEventTime: message.event_at !== null,
      sourceTokens: message.token_count, descendantCount: 0, descendantTokens: 0,
      coverage: [{ ...base, summaryIds: [], messageIds: [message.message_id], messageRange: [at, at] }] });
  }
  return { items, messageCount: count.n, revision };
}

export async function readMemories(db: DatabaseSync): Promise<Memory[]> {
  const rows = await readRows<{ id: string; content: string; tags: string; created_at: string }>(db, `SELECT id, content, tags, archived_at, source_summary_id, created_at FROM promoted
    WHERE archived_at IS NULL AND source_summary_id IS NULL ORDER BY id`, [], "id");
  return rows.filter(row => {
    const tags = parseStoredTags(row.tags);
    return tags !== null && !tags.some(tag => tag.startsWith("signal:") || tag === "source:passive-capture");
  }).map(row => ({ memoryId: row.id, revision: hash([row.content, row.tags, (row as { archived_at?: string }).archived_at]), content: row.content, createdAt: iso(row.created_at) }));
}

/** Claim validation is local to the unit's coverage, including newly added claims. */
export function readUnitMemories(db: DatabaseSync, from: string, to: string): Memory[] {
  const rows = db.prepare(`SELECT id, content, tags, archived_at, created_at FROM promoted WHERE archived_at IS NULL
    AND source_summary_id IS NULL AND julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?) ORDER BY id`)
    .all(from, to) as Array<{ id: string; content: string; tags: string; archived_at: string | null; created_at: string }>;
  return rows.flatMap(row => {
    const tags = parseStoredTags(row.tags);
    if (tags === null || tags.some(tag => tag.startsWith("signal:") || tag === "source:passive-capture")) return [];
    return [{ memoryId: row.id, content: row.content, createdAt: iso(row.created_at), revision: hash([row.content, row.tags, row.archived_at]) }];
  });
}

export function chronological(items: Item[]): Item[] {
  return [...items].sort(compareItems);
}

function compareItems(a: Item, b: Item): number {
    if (a.position !== undefined || b.position !== undefined) {
      const position = (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
      if (position !== 0) return position;
    }
    return a.to.localeCompare(b.to) || a.coverage[0].sessionId.localeCompare(b.coverage[0].sessionId)
      || a.coverage[0].conversationId - b.coverage[0].conversationId || (a.seq ?? -1) - (b.seq ?? -1) || a.id.localeCompare(b.id);
}

function workItem(work: Work): Item {
  return { id: work.key, content: "", tokens: 0, from: work.from, to: work.to, coverage: work.coverage,
    position: work.items[0].position, seq: work.items[0].seq, depth: 0, sourceTokens: 0, descendantCount: 0, descendantTokens: 0 };
}

export function orderedWork(work: Work[]): Work[] {
  return [...work].sort((a, b) => compareItems(workItem(a), workItem(b)));
}

/** Keep only boundaries that are known before pending digest output sizes exist. */
export function periodChunks(ready: Item[], pending: Work[], limit: number): Item[][] {
  const pendingKeys = new Set(pending.map(work => work.key));
  const result: Item[][] = [];
  let chunk: Item[] = [];
  let tokens = 0;
  let month = "";
  let blocked = false;
  for (const item of chronological([...ready, ...pending.map(workItem)])) {
    if (month !== item.to.slice(0, 7)) {
      if (chunk.length) result.push(chunk);
      chunk = []; tokens = 0; blocked = false; month = item.to.slice(0, 7);
    }
    if (pendingKeys.has(item.id)) { chunk = []; tokens = 0; blocked = true; continue; }
    if (blocked) {
      if (item.tokens < limit) continue;
      result.push([item]); blocked = false; continue;
    }
    if (chunk.length && tokens + item.tokens > limit) { result.push(chunk); chunk = []; tokens = 0; }
    chunk.push(item); tokens += item.tokens;
    if (tokens >= limit) { result.push(chunk); chunk = []; tokens = 0; }
  }
  if (chunk.length) result.push(chunk);
  return result;
}

export function chunks(items: Item[], limit: number): Item[][] {
  const result: Item[][] = [];
  let chunk: Item[] = [];
  let tokens = 0;
  for (const item of chronological(items)) {
    if (chunk.length && (tokens + item.tokens > limit || chunk[0].to.slice(0, 7) !== item.to.slice(0, 7))) {
      result.push(chunk); chunk = []; tokens = 0;
    }
    chunk.push(item); tokens += item.tokens;
    if (tokens >= limit) { result.push(chunk); chunk = []; tokens = 0; }
  }
  if (chunk.length) result.push(chunk);
  return result;
}

export function digestChunks(items: Item[], limit: number): Item[][] {
  const result: Item[][] = [];
  let run: Item[] = [];
  for (const item of chronological(items)) {
    if (item.messageId !== undefined) { run.push(item); continue; }
    result.push(...chunks(run, limit));
    run = [];
  }
  result.push(...chunks(run, limit));
  return result;
}

export function coverageOf(items: Item[]): Coverage[] {
  const sources = new Map<number, Coverage>();
  for (const source of items.flatMap(item => item.coverage)) {
    const current = sources.get(source.conversationId);
    if (!current) { sources.set(source.conversationId, { ...source, summaryIds: [...source.summaryIds], messageIds: [...source.messageIds] }); continue; }
    current.summaryIds = [...new Set([...current.summaryIds, ...source.summaryIds])];
    current.messageIds = [...new Set([...current.messageIds, ...source.messageIds])];
    if (source.messageRange) current.messageRange = current.messageRange
      ? [Math.min(current.messageRange[0], source.messageRange[0]), Math.max(current.messageRange[1], source.messageRange[1])] : source.messageRange;
  }
  return [...sources.values()];
}

export function workFor(items: Item[], level: Work["level"], memories: Memory[], generator: string): Work {
  const known = items.filter(item => item.hasEventTime);
  const bounds = known.length ? known : items;
  const from = bounds.reduce((date, item) => item.from < date ? item.from : date, bounds[0].from);
  const to = bounds.reduce((date, item) => item.to > date ? item.to : date, bounds[0].to);
  const claims = memories.filter(memory => memory.createdAt >= from && memory.createdAt <= to);
  const coverage = coverageOf(items);
  const key = hash({ level, inputs: items.map(({ content: _content, ...metadata }) => metadata), coverage, claims: claims.map(memory => [memory.memoryId, memory.revision]), generator });
  return { key, level, items, coverage, memories: claims, from, to, generator };
}
