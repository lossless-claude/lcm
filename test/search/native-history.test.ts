import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { searchNativeHistory } from "../../src/search/native-history.js";

let db: DatabaseSync;
let messages: ConversationStore;
let summaries: SummaryStore;
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  messages = new ConversationStore(db);
  summaries = new SummaryStore(db);
  await messages.createConversation({ sessionId: "native-context" });
});
afterEach(() => db.close());

async function seed(content: string) {
  return messages.createMessage({ conversationId: 1, seq: 1, role: "assistant", content, tokenCount: 50 });
}

it("returns the explanation beyond the short FTS snippet near a late match", async () => {
  const reason = "Retrying with bounded exponential backoff resolved the outage.";
  const content = "Unrelated history. ".repeat(200) + "Saffron failed. " + "Diagnostic detail. ".repeat(20) + reason;
  const source = await seed(content);
  const short = await messages.searchMessages({ query: "Saffron", mode: "full_text" });
  expect(short[0].snippet).not.toContain(reason);
  const [hit] = await searchNativeHistory(db, { query: "Saffron", limit: 5 });
  expect(hit).toMatchObject({ messageId: source.messageId, snippetTruncated: true });
  expect(hit.snippet).toContain(reason);
  expect(hit.snippet.length).toBeLessThanOrEqual(1000);
  expect(hit.span.start).toBeGreaterThan(0);
  expect(hit.snippet).toBe(content.slice(hit.span.start, hit.span.end));
  expect(hit.sourceHash).toBe(createHash("sha256").update(content).digest("hex"));
});

it("preserves complete short sources and message-before-summary ordering", async () => {
  const content = "Saffron recovered after a retry.";
  const message = await seed(content);
  await summaries.insertSummary({ summaryId: "summary", conversationId: 1, kind: "leaf", content, tokenCount: 10 });
  const hits = await searchNativeHistory(db, { query: "Saffron", limit: 5 });
  expect(hits).toHaveLength(2);
  expect(hits[0]).toMatchObject({ messageId: message.messageId, snippet: content, snippetTruncated: false });
  expect(hits[1]).toMatchObject({ summaryId: "summary", snippet: content });
  expect(await searchNativeHistory(db, { query: "Saffron", limit: 1 })).toHaveLength(1);
  expect(await searchNativeHistory(db, { query: "Saffron", limit: 0 })).toEqual([]);
});

it("keeps Unicode text intact at bounded snippet edges", async () => {
  const content = "🌿".repeat(800) + " Saffron " + "🌿".repeat(800);
  await seed(content);
  const [hit] = await searchNativeHistory(db, { query: "Saffron", limit: 1 });
  expect(hit.snippet).toContain("Saffron");
  expect(hit.snippet).not.toMatch(/\p{Surrogate}/u);
  expect(hit.snippet).toBe(content.slice(hit.span.start, hit.span.end));
  expect(hit.snippet.length).toBeLessThanOrEqual(1000);
});

it("preserves the caller's transaction and does not change source records", async () => {
  db.exec("BEGIN");
  await seed("Saffron decision.");
  expect(await searchNativeHistory(db, { query: "Saffron", limit: 1 })).toHaveLength(1);
  db.exec("ROLLBACK");
  expect(await messages.getMessageCount(1)).toBe(0);
});

it("keeps source context available when FTS is unavailable", async () => {
  const content = "Earlier context. ".repeat(100) + "Saffron recovered because retries were bounded.";
  await seed(content);
  db.exec("DROP TABLE messages_fts; DROP TABLE summaries_fts");
  const [hit] = await searchNativeHistory(db, { query: "Saffron", limit: 1 });
  expect(hit.snippet).toContain("recovered because retries were bounded");
  expect(hit.snippet).toBe(content.slice(hit.span.start, hit.span.end));
});

it("ranks a session corroborated by a message and a summary above a single top message", async () => {
  await messages.createConversation({ sessionId: "corroborated" });
  await seed("Saffron retry Saffron retry: the strongest single message.");
  await messages.createMessage({ conversationId: 2, seq: 1, role: "assistant", content: "Saffron retry noted in the message.", tokenCount: 10 });
  await summaries.insertSummary({ summaryId: "summary-2", conversationId: 2, kind: "leaf", content: "Saffron retry recorded in the summary.", tokenCount: 10 });
  const hits = await searchNativeHistory(db, { query: "Saffron retry", limit: 5 });
  expect(hits.map((hit) => hit.sessionId)).toEqual(["corroborated", "native-context", "corroborated"]);
  expect(hits[0]).toMatchObject({ conversationId: 2 });
  expect("messageId" in hits[0]).toBe(true);
  expect("summaryId" in hits[2]).toBe(true);
});

it("spreads a small limit across sessions before returning second hits", async () => {
  await messages.createConversation({ sessionId: "second" });
  await seed("Saffron once.");
  await messages.createMessage({ conversationId: 1, seq: 2, role: "assistant", content: "Saffron twice.", tokenCount: 5 });
  await messages.createMessage({ conversationId: 2, seq: 1, role: "assistant", content: "Saffron elsewhere.", tokenCount: 5 });
  const hits = await searchNativeHistory(db, { query: "Saffron", limit: 2 });
  expect(new Set(hits.map((hit) => hit.sessionId))).toEqual(new Set(["native-context", "second"]));
});

it("keeps concurrent reads on one connection bound to their source snapshot", async () => {
  const original = "Saffron recovered after bounded retries.";
  const replacement = "Juniper recovered after a circuit breaker.";
  const source = await seed(original);

  const first = searchNativeHistory(db, { query: "Saffron", limit: 1 });
  const second = searchNativeHistory(db, { query: "Saffron", limit: 1 });
  db.prepare("UPDATE messages SET content = ? WHERE message_id = ?")
    .run(replacement, source.messageId);
  db.prepare("UPDATE messages_fts SET content = ? WHERE rowid = ?")
    .run(replacement, source.messageId);

  for (const [hit] of await Promise.all([first, second])) {
    expect(hit.snippet).toBe(original.slice(hit.span.start, hit.span.end));
    expect(hit.sourceHash).toBe(createHash("sha256").update(original).digest("hex"));
  }

  const [updated] = await searchNativeHistory(db, { query: "Juniper", limit: 1 });
  expect(updated.snippet).toBe(replacement.slice(updated.span.start, updated.span.end));
  expect(updated.sourceHash).toBe(createHash("sha256").update(replacement).digest("hex"));
});

it("filters subagents and normalises session length in the synchronous search path", async () => {
  const content = "Saffron recovered after a retry.";
  await seed(`Saffron ${content}`);
  for (let seq = 2; seq <= 21; seq++) {
    await messages.createMessage({ conversationId: 1, seq, role: "user", content: "Unrelated maintenance detail.", tokenCount: 5 });
  }
  const short = await messages.createConversation({ sessionId: "short-human" });
  await messages.createMessage({ conversationId: short.conversationId, seq: 1, role: "user", content, tokenCount: 10 });
  const agent = await messages.createConversation({ sessionId: "agent-panel" });
  await messages.createMessage({ conversationId: agent.conversationId, seq: 1, role: "assistant", content: "Saffron Saffron Saffron", tokenCount: 10 });
  await summaries.insertSummary({ summaryId: "agent-summary", conversationId: agent.conversationId, kind: "leaf", content: "Saffron", tokenCount: 5 });

  const raw = await messages.searchMessages({ query: "Saffron", mode: "full_text" });
  expect(raw.findIndex(hit => hit.conversationId === 1)).toBeLessThan(raw.findIndex(hit => hit.conversationId === short.conversationId));
  const hits = await searchNativeHistory(db, { query: "Saffron", limit: 5 });
  expect(hits.map(hit => hit.sessionId)).toEqual(["short-human", "native-context"]);
});

it("releases the read snapshot and propagates synchronous read failures", async () => {
  const failure = vi.spyOn(ConversationStore.prototype, "searchMessagesSync")
    .mockImplementation(() => { throw new Error("native read failed"); });

  await expect(searchNativeHistory(db, { query: "Saffron", limit: 1 }))
    .rejects.toThrow("native read failed");
  failure.mockRestore();

  expect(() => db.exec("BEGIN; ROLLBACK")).not.toThrow();
});
