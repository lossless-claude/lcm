import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): DatabaseSync {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-conv-store-test-"));
  tempDirs.push(tempDir);
  const db = getLcmConnection(join(tempDir, "test.db"));
  runLcmMigrations(db);
  return db;
}

function makeStore(db: DatabaseSync): ConversationStore {
  return new ConversationStore(db, { fts5Available: false });
}

// ── Finding a conversation by session ─────────────────────────────────────────

describe("ConversationStore — conversations", () => {
  it("getOrCreateConversation opens a conversation for a new session", async () => {
    const store = makeStore(makeDb());
    const rec = await store.getOrCreateConversation("sess-1", "My Session");
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.title).toBe("My Session");
    expect(rec.conversationId).toBeGreaterThan(0);
    expect(rec.createdAt).toBeInstanceOf(Date);
    expect(rec.roleTagging).toBe("tagged");
  });

  it("getOrCreateConversation answers the same conversation for the same session", async () => {
    const store = makeStore(makeDb());
    const first = await store.getOrCreateConversation("idem-sess");
    const second = await store.getOrCreateConversation("idem-sess");
    expect(second.conversationId).toBe(first.conversationId);
    expect(await store.listConversations()).toHaveLength(1);
  });

  it("getOrCreateConversation fills attribution in once a sidecar names a parent, and never overwrites it", async () => {
    const store = makeStore(makeDb());
    const bare = await store.getOrCreateConversation("agent-1");
    expect(bare.parentSessionId).toBeNull();

    const attributed = await store.getOrCreateConversation("agent-1", undefined, {
      parentSessionId: "parent-a", subagentType: "explore", subagentDesc: "look around",
    });
    expect(attributed.conversationId).toBe(bare.conversationId);
    expect(attributed.parentSessionId).toBe("parent-a");
    expect(attributed.subagentType).toBe("explore");

    const later = await store.getOrCreateConversation("agent-1", undefined, { parentSessionId: "parent-b" });
    expect(later.parentSessionId).toBe("parent-a");
  });

  it("getConversationBySessionId finds what getOrCreateConversation opened, and null otherwise", async () => {
    const store = makeStore(makeDb());
    const opened = await store.getOrCreateConversation("find-me");
    expect((await store.getConversationBySessionId("find-me"))?.conversationId).toBe(opened.conversationId);
    expect(await store.getConversationBySessionId("no-such-session")).toBeNull();
    expect(await store.getConversation(opened.conversationId)).toEqual(opened);
    expect(await store.getConversation(9999)).toBeNull();
  });

  it("getConversationBySessionId breaks same-second ties by the newest row", async () => {
    const db = makeDb();
    const store = makeStore(db);
    db.prepare(
      `INSERT INTO conversations (session_id, role_tagging, created_at)
       VALUES (?, 'tagged', ?)`,
    ).run("duplicate-session", "2026-09-19 04:00:00");
    const newer = db.prepare(
      `INSERT INTO conversations (session_id, role_tagging, created_at)
       VALUES (?, 'tagged', ?)`,
    ).run("duplicate-session", "2026-09-19 04:00:00");

    expect((await store.getConversationBySessionId("duplicate-session"))?.conversationId).toBe(Number(newer.lastInsertRowid));
  });

  it("listConversations returns every conversation in creation order", async () => {
    const store = makeStore(makeDb());
    await store.getOrCreateConversation("list-1");
    await store.getOrCreateConversation("list-2");
    expect((await store.listConversations()).map((c) => c.sessionId)).toEqual(["list-1", "list-2"]);
  });

  it("latestActiveConversation picks the conversation with the newest user/assistant message or summary, never the excluded session", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const summaries = new SummaryStore(db, { fts5Available: false });

    const empty = await store.getOrCreateConversation("empty-shell");
    const older = await store.getOrCreateConversation("older");
    const newer = await store.getOrCreateConversation("newer");
    await store.createMessage({ conversationId: older.conversationId, seq: 0, role: "user", content: "old", tokenCount: 1 });
    await store.createMessage({ conversationId: newer.conversationId, seq: 0, role: "user", content: "new", tokenCount: 1 });
    db.prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ?`).run("2026-01-01 00:00:00", older.conversationId);
    db.prepare(`UPDATE messages SET created_at = ? WHERE conversation_id = ?`).run("2026-02-01 00:00:00", newer.conversationId);

    expect((await store.latestActiveConversation("empty-shell"))?.conversationId).toBe(newer.conversationId);
    expect((await store.latestActiveConversation("newer"))?.conversationId).toBe(older.conversationId);

    // A later summary outranks an earlier message.
    await summaries.insertSummary({ summaryId: "s-old", conversationId: older.conversationId, kind: "leaf", content: "x", tokenCount: 1 });
    db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`).run("2026-03-01 00:00:00", "s-old");
    expect((await store.latestActiveConversation("empty-shell"))?.conversationId).toBe(older.conversationId);

    // A conversation with only a tool message is not active.
    await store.createMessage({ conversationId: empty.conversationId, seq: 0, role: "tool", content: "log", tokenCount: 1 });
    expect((await store.latestActiveConversation("older"))?.conversationId).toBe(newer.conversationId);
  });
});

// ── Appending a delta and reading it back ─────────────────────────────────────

describe("ConversationStore — messages", () => {
  let store: ConversationStore;
  let conversationId: number;

  beforeEach(async () => {
    store = makeStore(makeDb());
    conversationId = (await store.getOrCreateConversation("msg-sess")).conversationId;
  });

  it("createMessage then getMessages returns the message as written", async () => {
    const msg = await store.createMessage({ conversationId, seq: 1, role: "user", content: "hello world", tokenCount: 2 });
    expect(msg).toMatchObject({ conversationId, seq: 1, role: "user", content: "hello world", tokenCount: 2 });
    expect(await store.getMessages(conversationId)).toEqual([msg]);
    expect(await store.getMessageById(msg.messageId)).toEqual(msg);
    expect(await store.getMessageById(99999)).toBeNull();
  });

  it("createMessagesBulk appends a delta that getMessages reads back in seq order", async () => {
    const records = await store.createMessagesBulk([
      { conversationId, seq: 10, role: "user", content: "bulk1", tokenCount: 1 },
      { conversationId, seq: 11, role: "assistant", content: "bulk2", tokenCount: 1 },
    ]);
    expect(records.map((r) => r.content)).toEqual(["bulk1", "bulk2"]);
    expect((await store.getMessages(conversationId)).map((m) => m.seq)).toEqual([10, 11]);
    expect(await store.createMessagesBulk([])).toEqual([]);
  });

  it("getMessages reads past a seq, or only the stored prefix", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.createMessage({ conversationId, seq: i, role: "user", content: `msg${i}`, tokenCount: 1 });
    }
    expect((await store.getMessages(conversationId, { afterSeq: 3 })).map((m) => m.seq)).toEqual([4, 5]);
    expect((await store.getMessages(conversationId, { limit: 3 })).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("getMessageCount and getMaxSeq describe what is stored, per conversation or in all", async () => {
    expect(await store.getMessageCount(conversationId)).toBe(0);
    expect(await store.getMaxSeq(conversationId)).toBe(0);
    await store.createMessage({ conversationId, seq: 5, role: "user", content: "x", tokenCount: 1 });
    await store.createMessage({ conversationId, seq: 3, role: "user", content: "y", tokenCount: 1 });
    const other = await store.getOrCreateConversation("other");
    await store.createMessage({ conversationId: other.conversationId, seq: 0, role: "user", content: "z", tokenCount: 1 });

    expect(await store.getMessageCount(conversationId)).toBe(2);
    expect(await store.getMaxSeq(conversationId)).toBe(5);
    expect(await store.getMessageCount()).toBe(3);
  });

  it("withTransaction rolls back the delta on a thrown error and re-throws", async () => {
    await expect(
      store.withTransaction(async () => {
        await store.createMessage({ conversationId, seq: 1, role: "user", content: "aborted", tokenCount: 1 });
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    expect(await store.getMessageCount(conversationId)).toBe(0);
  });
});

// ── Message parts ─────────────────────────────────────────────────────────────

describe("ConversationStore — message parts", () => {
  it("a message written with a compaction part is left out when the context is rebuilt", async () => {
    const db = makeDb();
    const store = makeStore(db);
    const summaries = new SummaryStore(db, { fts5Available: false });
    const conv = await store.getOrCreateConversation("parts-sess");
    const kept = await store.createMessage({ conversationId: conv.conversationId, seq: 0, role: "user", content: "kept", tokenCount: 1 });
    const event = await store.createMessage({ conversationId: conv.conversationId, seq: 1, role: "system", content: "compacted", tokenCount: 1 });
    await store.createMessageParts(event.messageId, [{ sessionId: "parts-sess", partType: "compaction", ordinal: 0 }]);
    await store.createMessageParts(kept.messageId, []);

    await summaries.resetConversationContext(conv.conversationId);

    expect((await summaries.getContextItems(conv.conversationId)).map((i) => i.messageId)).toEqual([kept.messageId]);
    expect(await store.getMessageById(event.messageId)).toBeNull();
  });
});

// ── Search ────────────────────────────────────────────────────────────────────

describe("ConversationStore — searchMessagesSync", () => {
  it("regex mode finds matching messages, honours the limit, and refuses an unsafe pattern", async () => {
    const store = makeStore(makeDb());
    const conv = await store.getOrCreateConversation("search-sess");
    for (let i = 1; i <= 5; i++) {
      await store.createMessage({ conversationId: conv.conversationId, seq: i, role: "user", content: `token-${i} React`, tokenCount: 2 });
    }
    await store.createMessage({ conversationId: conv.conversationId, seq: 6, role: "user", content: "prefer Vue", tokenCount: 2 });

    expect(store.searchMessagesSync({ query: "React|Vue", mode: "regex" })).toHaveLength(6);
    expect(store.searchMessagesSync({ query: "token-\\d", mode: "regex", limit: 2 })).toHaveLength(2);
    expect(store.searchMessagesSync({ query: "xyz123nomatch", mode: "regex" })).toHaveLength(0);
    expect(() => store.searchMessagesSync({ query: "(a+)+$", mode: "regex" })) // codeql[js/redos] - intentional test input
      .toThrow(/unsafe/i);
  });

  it("full_text mode falls back to a substring scan without FTS5", async () => {
    const store = makeStore(makeDb());
    const conv = await store.getOrCreateConversation("like-sess");
    await store.createMessage({ conversationId: conv.conversationId, seq: 1, role: "user", content: "database migration fallback", tokenCount: 3 });
    const results = store.searchMessagesSync({ query: "database migration", mode: "full_text", conversationId: conv.conversationId });
    expect(results).toHaveLength(1);
    expect(results[0].snippet.toLowerCase()).toContain("database migration");
  });
});
