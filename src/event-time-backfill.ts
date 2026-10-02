import type { DatabaseSync } from "node:sqlite";
import type { TranscriptCaptureInput } from "./capture.js";
import type { ScrubEngine } from "./scrub.js";
import type { ParsedMessage } from "./transcript.js";
import { WorkerStore } from "./store/worker-store.js";
import { ConversationStore, type MessageRecord } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { transcriptSource, type TranscriptDelta } from "./transcript-source.js";
import { compareStoredMessageContent } from "./message-content.js";
import { yieldToEventLoop } from "./daemon/project-queue.js";

type Scrub = (text: string) => string;
type Alignment = { messages: ParsedMessage[]; fileOrder: boolean; next: number; aligned: boolean };
const matches = (stored: MessageRecord, current: ParsedMessage | undefined, scrub: Scrub) =>
  current !== undefined && stored.role === current.role && compareStoredMessageContent(stored.content, current.content, scrub) !== undefined;

/** Prefer the live prefix, as capture does; otherwise require unique file-order matches, as rebuild does. */
async function alignmentFor(store: ConversationStore, sessionId: string, read: TranscriptDelta, scrub: Scrub): Promise<Alignment> {
  if (read.eventTimeCandidates) for (let offset = 0; ; offset += 256) {
    const page = await store.getSessionMessages(sessionId, offset, 256);
    const aligned = page.every((message, index) => matches(message, read.messages[offset + index], scrub));
    await yieldToEventLoop();
    if (!aligned) return { messages: read.eventTimeCandidates, fileOrder: true, next: 0, aligned: true };
    if (page.length < 256) break;
  }
  return { messages: read.messages, fileOrder: false, next: 0, aligned: true };
}

async function matchedRecord(state: Alignment, stored: MessageRecord, position: number, scrub: Scrub): Promise<ParsedMessage | undefined> {
  if (!state.aligned) return undefined;
  let found = state.fileOrder ? -1 : position;
  if (state.fileOrder) for (let index = state.next; index < state.messages.length; index++) {
    if (index % 256 === 0) await yieldToEventLoop();
    if (!matches(stored, state.messages[index], scrub)) continue;
    if (found !== -1) { state.aligned = false; return undefined; }
    found = index;
  }
  const record = state.messages[found];
  state.aligned = matches(stored, record, scrub);
  state.next = found + 1;
  return state.aligned ? record : undefined;
}

/** Repair verified session positions only; NULL rows are the resumable work queue. */
export async function backfillSessionEventTimes(
  db: DatabaseSync, input: TranscriptCaptureInput, scrubber: ScrubEngine,
): Promise<{ updated: number; unknown: number }> {
  const conversations = new ConversationStore(db);
  if (new WorkerStore(db).excluded(input.sessionId)) return { updated: 0, unknown: 0 };
  const source = transcriptSource(input.client);
  const path = source.locate({ ...input, allowMissing: true });
  const scrub = (text: string) => scrubber.scrubWithCounts(text).text;
  const read = path ? await source.read(path, undefined, { ...input, scrub, eventTimeRepair: true })
    : { messages: [], sourceOffset: 0, backfillModels() {} };
  const alignment = await alignmentFor(conversations, input.sessionId, read, scrub);
  let updated = 0, unknown = 0;
  const ids = new Set<number>();
  for (let offset = 0; ; offset += 256) {
    const page = await conversations.getSessionMessages(input.sessionId, offset, 256);
    const repairs: Parameters<ConversationStore["backfillMessageEventTimes"]>[0][number][] = [];
    for (const [index, message] of page.entries()) {
      ids.add(message.conversationId);
      const record = await matchedRecord(alignment, message, offset + index, scrub);
      if (message.eventAt) continue;
      if (record?.eventAt) repairs.push({ messageId: message.messageId, content: message.content, role: message.role, eventAt: record.eventAt });
      else unknown++;
    }
    updated += await conversations.withTransaction(() => conversations.backfillMessageEventTimes(repairs));
    await yieldToEventLoop();
    if (page.length < 256) break;
  }
  // Also repairs bounds on an idempotent retry after an interrupted bounds pass.
  const summaries = new SummaryStore(db);
  for (const id of ids) await summaries.recomputeTimeBounds(id);
  return { updated, unknown };
}
