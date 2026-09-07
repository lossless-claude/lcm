import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { RetrievalEngine } from "../../src/retrieval.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";

describe("full-text relevance survives retrieval and candidate limits", () => {
  let db: DatabaseSync;
  let engine: RetrievalEngine;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    engine = new RetrievalEngine(conversations, summaries);

    for (const [index, content] of [
      "The quasar indexing regression was fixed.",
      `A quasar was mentioned once. ${"Routine unrelated maintenance. ".repeat(100)}`,
    ].entries()) {
      const conversation = await conversations.createConversation({ sessionId: `session-${index}` });
      await conversations.createMessage({
        conversationId: conversation.conversationId, seq: 0, role: "user", content, tokenCount: 20,
      });
      await summaries.insertSummary({
        summaryId: `summary-${index}`, conversationId: conversation.conversationId,
        kind: "leaf", content, tokenCount: 20,
      });
      const date = index === 0 ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z";
      db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ?").run(date, conversation.conversationId);
      db.prepare("UPDATE summaries SET created_at = ? WHERE conversation_id = ?").run(date, conversation.conversationId);
    }
  });

  afterEach(() => db.close());

  it.each(["quasar", "quasar absentword"])("ranks the older relevant match first for %s", async (query) => {
    const result = await engine.grep({ query, mode: "full_text", scope: "both" });
    expect(result.messages.map((m) => m.conversationId)).toEqual([1, 2]);
    expect(result.summaries.map((s) => s.conversationId)).toEqual([1, 2]);
  });

  it("applies relevance before limiting candidates in each store", async () => {
    const result = await engine.grep({ query: "quasar", mode: "full_text", scope: "both", limit: 1 });
    expect(result.messages.map((m) => m.conversationId)).toEqual([1]);
    expect(result.summaries.map((s) => s.conversationId)).toEqual([1]);
  });

  it("preserves chronological ordering for regex lookup", async () => {
    const result = await engine.grep({ query: "quasar", mode: "regex", scope: "both" });
    expect(result.messages.map((m) => m.conversationId)).toEqual([2, 1]);
    expect(result.summaries.map((s) => s.conversationId)).toEqual([2, 1]);
  });
});

describe("full-text candidate fill", () => {
  let db: DatabaseSync;
  let engine: RetrievalEngine;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);
    const conversations = new ConversationStore(db);
    const summaries = new SummaryStore(db);
    engine = new RetrievalEngine(conversations, summaries);
    for (const [index, content] of [
      "Only the lantern is mentioned here.",
      "Both the lantern and the compass appear here.",
      "Only the compass is mentioned here.",
    ].entries()) {
      const conversation = await conversations.createConversation({ sessionId: `session-${index}` });
      await conversations.createMessage({ conversationId: conversation.conversationId, seq: 0, role: "user", content, tokenCount: 10 });
      await summaries.insertSummary({ summaryId: `summary-${index}`, conversationId: conversation.conversationId, kind: "leaf", content, tokenCount: 10 });
    }
  });

  afterEach(() => db.close());

  it("keeps all-term matches first and fills remaining slots with any-term matches", async () => {
    const result = await engine.grep({ query: "lantern compass", mode: "full_text", scope: "both" });
    expect(result.messages.map((m) => m.conversationId)).toEqual([2, 1, 3]);
    expect(result.summaries.map((s) => s.conversationId)).toEqual([2, 1, 3]);
  });

  it("respects the candidate limit while filling", async () => {
    const result = await engine.grep({ query: "lantern compass", mode: "full_text", scope: "both", limit: 2 });
    expect(result.messages.map((m) => m.conversationId)).toEqual([2, 1]);
    expect(result.summaries).toHaveLength(2);
  });
});
