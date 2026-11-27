import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { runLcmMigrations } from "../../src/db/migration.js";
import { ensureTimelineOwner } from "../../src/db/project-timeline.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { countContextCoverage } from "../../src/store/context-coverage.js";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

async function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  runLcmMigrations(db);
  const conversations = new ConversationStore(db, { fts5Available: false });
  const summaries = new SummaryStore(db, { fts5Available: false });
  const { conversationId } = await conversations.getOrCreateConversation("coverage");
  let seq = 0;
  const createMessages = async (count: number, owner = conversationId) =>
    (await conversations.createMessagesBulk(Array.from({ length: count }, () => ({
      conversationId: owner, seq: seq++, role: "user" as const, content: "message", tokenCount: 1,
    })))).map(message => message.messageId);
  // Links sources the way compaction does: messages for a leaf, lower-depth summaries for a condensed one.
  const summarize = async (summaryId: string, depth: number, sources: { messageIds?: number[]; parentIds?: string[] }, owner = conversationId) => {
    await summaries.insertSummary({ summaryId, conversationId: owner, kind: depth === 0 ? "leaf" : "condensed", depth, content: summaryId, tokenCount: 1 });
    await summaries.linkSummaryToMessages(summaryId, sources.messageIds ?? []);
    await summaries.linkSummaryToParents(summaryId, sources.parentIds ?? []);
  };
  const place = (summaryId: string, ordinal: number, owner = conversationId) =>
    summaries.replaceContextRangeWithSummary({ conversationId: owner, startOrdinal: ordinal, endOrdinal: ordinal, summaryId });
  return { db, conversations, summaries, conversationId, createMessages, summarize, place };
}

it("counts every way the context covers a message, and 0 for a message it does not cover", async () => {
  const { db, summaries, conversationId, createMessages, summarize, place } = await fixture();
  const [inBoth, summarized, inContext] = await createMessages(3);
  await summaries.appendContextMessages(conversationId, [inBoth, summarized, inContext]);
  // A summary that also cites a message still in context: a duplicate.
  await summarize("leaf", 0, { messageIds: [inBoth, summarized] });
  await place("leaf", 1);
  const [uncovered] = await createMessages(1);
  expect(countContextCoverage(db, conversationId)).toEqual([
    { conversationId, messageId: inBoth, coverage: 2 },
    { conversationId, messageId: summarized, coverage: 1 },
    { conversationId, messageId: inContext, coverage: 1 },
    { conversationId, messageId: uncovered, coverage: 0 },
  ]);
});

it("leaves out compaction-event messages and the timeline conversation", async () => {
  const { db, conversations, summaries, conversationId, createMessages, summarize, place } = await fixture();
  const [captured, event] = await createMessages(2);
  await summaries.appendContextMessages(conversationId, [captured]);
  await conversations.createMessageParts(event, [{ sessionId: "coverage", partType: "compaction", ordinal: 0, textContent: "event" }]);
  // The timeline's own context, with a summary that cites the session's message.
  const timelineId = ensureTimelineOwner(db);
  const [entry] = await createMessages(1, timelineId);
  await summaries.appendContextMessages(timelineId, [entry]);
  await summarize("timeline-digest", 0, { messageIds: [captured] }, timelineId);
  await place("timeline-digest", 1, timelineId);
  expect(countContextCoverage(db)).toEqual([{ conversationId, messageId: captured, coverage: 1 }]);
});

it("follows only lower-depth sources, so malformed lineage proves no coverage", async () => {
  const { db, conversationId, createMessages, summarize, place } = await fixture();
  const [cited, citedBySameDepth] = await createMessages(2);
  await summarize("leaf", 0, { messageIds: [cited] });
  await summarize("same-depth", 1, { messageIds: [citedBySameDepth] });
  await summarize("condensed", 1, { parentIds: ["leaf", "same-depth"] });
  await place("condensed", 0);
  expect(countContextCoverage(db, conversationId).map(row => row.coverage)).toEqual([1, 0]);
});

it("ends on a lineage cycle and counts its sources once", async () => {
  const { db, summaries, conversationId, createMessages, summarize, place } = await fixture();
  const [cited] = await createMessages(1);
  await summarize("leaf", 0, { messageIds: [cited] });
  await summarize("condensed", 1, { parentIds: ["leaf"] });
  // A back edge: the leaf names the summary that condensed it as its own source.
  await summaries.linkSummaryToParents("leaf", ["condensed"]);
  await place("condensed", 0);
  expect(countContextCoverage(db, conversationId).map(row => row.coverage)).toEqual([1]);
});
