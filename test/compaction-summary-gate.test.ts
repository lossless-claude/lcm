import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionEngine, type CompactionConfig, type CompactionSummarizeFn } from "../src/compaction.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { createOpenAISummarizer } from "../src/llm/openai.js";
import { SummaryRejectedError } from "../src/llm/summary-rejection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const CONFIG: CompactionConfig = {
  contextThreshold: 0.5,
  freshTailCount: 0,
  leafMinFanout: 2,
  condensedMinFanout: 2,
  leafChunkTokens: 2_000,
  condensedTargetTokens: 100,
};

/** Enough 1,200-token messages for several leaf chunks and a condensed pass over them. */
const MESSAGE_COUNT = 6;

/** Every table a compaction pass writes: a rejected pass must leave all of them as they were. */
const WRITTEN_TABLES = ["context_items", "summaries", "summary_messages", "summary_parents", "messages", "message_parts"];

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

async function conversationWithMessages() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  runLcmMigrations(db);
  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const { conversationId } = await conversationStore.getOrCreateConversation("gate-session");
  const records = await conversationStore.createMessagesBulk(
    Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
      conversationId, seq: i, role: i % 2 ? "assistant" as const : "user" as const,
      content: `message ${i} `.repeat(400), tokenCount: 1_200,
    })),
  );
  await summaryStore.appendContextMessages(conversationId, records.map((r) => r.messageId));
  const engine = new CompactionEngine(conversationStore, summaryStore, CONFIG);
  const snapshot = () => Object.fromEntries(
    WRITTEN_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
  );
  const compact = (summarize: CompactionSummarizeFn) =>
    engine.compact({ conversationId, tokenBudget: 10_000, summarize, force: true });
  return { db, snapshot, compact };
}

describe("CompactionEngine summary gate", () => {
  it("writes leaf and condensed depth and metadata before another migration", async () => {
    const { db, compact } = await conversationWithMessages();
    db.exec("UPDATE messages SET created_at = '2026-01-01T10:00:00.000Z'");
    let leaves = 0;
    await compact(async (_text, _aggressive, options) =>
      options?.isCondensed
        ? `Condensed summary ${"durable fact ".repeat(20)}`
        : `Leaf summary ${++leaves}: ${"durable fact ".repeat(20)}`,
    );

    const summaries = db.prepare(`
      SELECT summary_id, kind, depth, token_count, earliest_at, latest_at,
             descendant_count, descendant_token_count, source_message_token_count
      FROM summaries ORDER BY depth, summary_id
    `).all() as Array<{
      summary_id: string; kind: string; depth: number; token_count: number;
      earliest_at: string | null; latest_at: string | null;
      descendant_count: number; descendant_token_count: number; source_message_token_count: number;
    }>;
    const leafRows = summaries.filter((summary) => summary.kind === "leaf");
    const condensedRows = summaries.filter((summary) => summary.kind === "condensed");
    expect(leafRows.length).toBeGreaterThan(1);
    expect(condensedRows.length).toBeGreaterThan(0);

    for (const leaf of leafRows) {
      const source = db.prepare(`
        SELECT MIN(m.created_at) AS earliest_at, MAX(m.created_at) AS latest_at,
               SUM(m.token_count) AS token_count
        FROM summary_messages sm JOIN messages m ON m.message_id = sm.message_id
        WHERE sm.summary_id = ?
      `).get(leaf.summary_id) as { earliest_at: string; latest_at: string; token_count: number };
      expect(leaf).toMatchObject({
        depth: 0, descendant_count: 0, descendant_token_count: 0,
        source_message_token_count: source.token_count,
        earliest_at: new Date(source.earliest_at).toISOString(),
        latest_at: new Date(source.latest_at).toISOString(),
      });
    }

    const byId = new Map(summaries.map((summary) => [summary.summary_id, summary]));
    for (const condensed of condensedRows) {
      const parents = db.prepare("SELECT parent_summary_id FROM summary_parents WHERE summary_id = ? ORDER BY ordinal")
        .all(condensed.summary_id) as Array<{ parent_summary_id: string }>;
      const children = parents.map((parent) => byId.get(parent.parent_summary_id)!);
      expect(children.length).toBeGreaterThan(0);
      expect(condensed).toMatchObject({
        depth: Math.max(...children.map((child) => child.depth)) + 1,
        earliest_at: new Date(Math.min(...children.map((child) => new Date(child.earliest_at!).getTime()))).toISOString(),
        latest_at: new Date(Math.max(...children.map((child) => new Date(child.latest_at!).getTime()))).toISOString(),
        descendant_count: children.reduce((sum, child) => sum + child.descendant_count + 1, 0),
        descendant_token_count: children.reduce((sum, child) => sum + child.descendant_token_count + child.token_count, 0),
        source_message_token_count: children.reduce((sum, child) => sum + child.source_message_token_count, 0),
      });
    }
  });

  it("a rejected leaf answer persists nothing: no summary, no links, context unchanged", async () => {
    const { db, snapshot, compact } = await conversationWithMessages();
    const before = snapshot();

    await expect(compact(async () => " \n\t ")).rejects.toBeInstanceOf(SummaryRejectedError);

    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 0 });
  });

  it("a cut-off OpenAI-compatible answer stores nothing, however readable its text", async () => {
    const { snapshot, compact } = await conversationWithMessages();
    const before = snapshot();
    const create = async () => ({
      choices: [{ finish_reason: "length", message: { content: "Chronology and main decisions:\nThe agent" } }],
      usage: { prompt_tokens: 15_000, completion_tokens: 1_024, total_tokens: 16_024 },
    });
    const summarize = createOpenAISummarizer({
      model: "reasoner", baseURL: "https://api.example.test",
      _clientOverride: { chat: { completions: { create } } }, _retryDelayMs: 0,
    });

    await expect(compact(summarize)).rejects.toMatchObject({ name: "SummaryRejectedError", reason: "length" });

    expect(snapshot()).toEqual(before);
  });

  it("an adapter's rejection propagates unchanged and is never replaced by a fallback summary", async () => {
    const { snapshot, compact } = await conversationWithMessages();
    const before = snapshot();
    const rejection = new SummaryRejectedError({ reason: "length", provider: "openai", model: "reasoner" });

    await expect(compact(async () => { throw rejection; })).rejects.toBe(rejection);

    expect(snapshot()).toEqual(before);
  });

  it("a rejected aggressive retry does not escalate to the deterministic fallback", async () => {
    const { db, snapshot, compact } = await conversationWithMessages();
    const before = snapshot();
    // The normal answer is no smaller than its source, which asks for the aggressive
    // prompt; that answer is rejected, so nothing is stored — not a truncated copy of the source.
    const summarize: CompactionSummarizeFn = async (text, aggressive) => (aggressive ? "" : `${text} ${text}`);

    await expect(compact(summarize)).rejects.toBeInstanceOf(SummaryRejectedError);

    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE content LIKE '%[Truncated from%'").get()).toEqual({ n: 0 });
  });

  it("a rejected condensed answer keeps the leaf passes before it and changes nothing else", async () => {
    const { db, snapshot, compact } = await conversationWithMessages();
    let leafState: ReturnType<typeof snapshot> | undefined;
    let leaves = 0;
    const summarize: CompactionSummarizeFn = async (_text, _aggressive, options) => {
      if (options?.isCondensed) {
        leafState = snapshot();
        return "   ";
      }
      return `Leaf summary ${++leaves}: ${"durable fact ".repeat(50)}`;
    };

    await expect(compact(summarize)).rejects.toBeInstanceOf(SummaryRejectedError);

    expect(leafState).toBeDefined();
    expect(snapshot()).toEqual(leafState);
    const kinds = db.prepare("SELECT kind, COUNT(*) AS n FROM summaries GROUP BY kind").all();
    expect(kinds).toEqual([{ kind: "leaf", n: expect.any(Number) }]);
  });
});

describe("CompactionEngine summary ids", () => {
  it("gives identical summaries created in the same millisecond distinct ids", async () => {
    const { db, compact } = await conversationWithMessages();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
    try {
      await compact(async () => `Identical summary ${"durable fact ".repeat(20)}`);
    } finally {
      clock.mockRestore();
    }
    const ids = (db.prepare("SELECT summary_id FROM summaries").all() as Array<{ summary_id: string }>).map((row) => row.summary_id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
