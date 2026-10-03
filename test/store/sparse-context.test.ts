import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { readCompactionContext } from "../../src/daemon/compaction-context.js";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  runLcmMigrations(db);
  const conversations = new ConversationStore(db, { fts5Available: false });
  const store = new SummaryStore(db, { fts5Available: false });
  const { conversationId } = await conversations.getOrCreateConversation("sparse-context");
  let seq = 0;
  const append = async (count: number) => {
    const messages = await conversations.createMessagesBulk(Array.from({ length: count }, () => ({
      conversationId, seq: seq++, role: "user" as const, content: `message ${seq}`, tokenCount: 1,
    })));
    await store.appendContextMessages(conversationId, messages.map(message => message.messageId));
    return messages;
  };
  const replace = async (startOrdinal: number, endOrdinal: number, summaryId: string) => {
    await store.insertSummary({ summaryId, conversationId, kind: "leaf", content: summaryId, tokenCount: 1 });
    await store.replaceContextRangeWithSummary({ conversationId, startOrdinal, endOrdinal, summaryId });
  };
  return { db, store, conversationId, append, replace };
}

it("leaves ordinals outside the replaced range unchanged, including on an existing dense store", async () => {
  const { db, store, conversationId, append, replace } = await fixture();
  const messages = await append(8);
  const schema = db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
  await replace(1, 4, "first");
  expect((await store.getContextItems(conversationId)).map(item => item.ordinal)).toEqual([0, 1, 5, 6, 7]);
  await replace(1, 6, "second"); // A range spanning an existing gap.
  const [appended] = await append(1);
  expect((await store.getContextItems(conversationId)).map(item => [item.ordinal, item.summaryId ?? item.messageId]))
    .toEqual([[0, messages[0].messageId], [1, "second"], [7, messages[7].messageId], [8, appended.messageId]]);
  expect(db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
});

it.each([100, 10_000])("changes only range-size plus one rows in a %i-item conversation", async (count) => {
  const { db, store, conversationId, append } = await fixture();
  await append(count);
  await store.insertSummary({ summaryId: "bounded", conversationId, kind: "leaf", content: "bounded", tokenCount: 1 });
  const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const before = changes();
  await store.replaceContextRangeWithSummary({ conversationId, startOrdinal: 10, endOrdinal: 12, summaryId: "bounded" });
  expect(changes() - before).toBe(4);
});

it.each([1, 42, 805, 0xdeadbeef])("matches dense replacement order over randomized appends and ranges (seed %i)", async (seed) => {
  const { store, conversationId, append, replace } = await fixture();
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  // Array splicing is the old dense-ordinal behaviour, without depending on sparse ordinals.
  const dense: Array<number | string> = [];
  for (let step = 0; step < 200; step++) {
    if (dense.length < 2 || random(3) === 0) {
      dense.push(...(await append(1 + random(6))).map(message => message.messageId));
    } else {
      const start = random(dense.length);
      const length = 1 + random(Math.min(8, dense.length - start));
      const items = await store.getContextItems(conversationId);
      const id = `summary-${step}`;
      await replace(items[start].ordinal, items[start + length - 1].ordinal, id);
      dense.splice(start, length, id);
    }
    expect((await store.getContextItems(conversationId)).map(item => item.summaryId ?? item.messageId)).toEqual(dense);
  }
});

it("reads suffixes, depth bounds, restore windows and exported context across gaps", async () => {
  const { store, conversationId, append, replace } = await fixture();
  const messages = await append(8);
  await replace(0, 2, "early summary");
  await store.linkSummaryToMessages("early summary", messages.slice(0, 3).map(message => message.messageId));
  await replace(3, 5, "later summary");
  await store.linkSummaryToMessages("later summary", messages.slice(3, 6).map(message => message.messageId));
  expect((await store.getContextItems(conversationId)).map(item => item.ordinal)).toEqual([0, 3, 6, 7]);
  expect((await store.getContextItems(conversationId, { afterOrdinal: 3 })).map(item => item.messageId))
    .toEqual(messages.slice(6).map(message => message.messageId));
  expect(await store.getDistinctDepthsInContext(conversationId, { maxOrdinalExclusive: 3 })).toEqual([0]);
  expect((await store.readContextWindow(conversationId, 1)).map(item => item.content)).toEqual(["later summary", "message 8"]);
  expect((await store.readContextWindow(conversationId, 0, { complete: true })).map(item => item.content))
    .toEqual(["early summary", "later summary", "message 7", "message 8"]);
  expect(await store.getContextTokenCount(conversationId)).toBe(4);
  const exported = await readCompactionContext(store, conversationId, 100_000);
  expect(exported.status).toBe("ready");
  expect(exported).toMatchObject({ uncoveredMessageIds: [], valid: true });
  if (exported.status === "ready") {
    const offsets = ["early summary", "later summary", "message 7", "message 8"].map(text => exported.text.indexOf(text));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  }
});
