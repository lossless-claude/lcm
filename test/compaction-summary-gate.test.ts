import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  condensedMinFanoutHard: 2,
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
