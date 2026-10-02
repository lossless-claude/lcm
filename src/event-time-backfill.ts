import type { DatabaseSync } from "node:sqlite";
import type { TranscriptCaptureInput } from "./capture.js";
import { REDACTION_MARKER, type ScrubEngine } from "./scrub.js";
import type { ParsedMessage } from "./transcript.js";
import { WorkerStore } from "./store/worker-store.js";
import { ConversationStore, type MessageRecord } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { recordSessionWebUrls } from "./store/session-url-store.js";
import { transcriptSource, type TranscriptDelta } from "./transcript-source.js";
import { compareStoredMessageContent, normalizeMessageContent } from "./message-content.js";
import { yieldToEventLoop } from "./daemon/project-queue.js";

type Scrub = (text: string) => string;
const REPAIR_PAGE_SIZE = 256;
const WILDCARD_COMPARISONS_PER_RECORD = 4;
type ContentIndex = Map<string, number[]>;
type Alignment = { messages: ParsedMessage[]; index?: { raw: ContentIndex; scrubbed: ContentIndex; budget: number }; next: number; aligned: boolean };
const key = (role: string, content: string) => JSON.stringify([role, content]);
const matches = (stored: MessageRecord, current: ParsedMessage | undefined, scrub: Scrub) =>
  current !== undefined && stored.role === current.role && compareStoredMessageContent(stored.content, current.content, scrub) !== undefined;

async function fileOrderAlignment(messages: ParsedMessage[], scrub: Scrub): Promise<Alignment> {
  const raw: ContentIndex = new Map(), scrubbed: ContentIndex = new Map();
  const add = (index: ContentIndex, contentKey: string, position: number) => {
    const positions = index.get(contentKey) ?? [];
    if (positions.at(-1) !== position) positions.push(position);
    index.set(contentKey, positions);
  };
  for (const [position, message] of messages.entries()) {
    add(raw, key(message.role, message.content), position);
    add(raw, key(message.role, normalizeMessageContent(message.content)), position);
    add(scrubbed, key(message.role, normalizeMessageContent(scrub(message.content))), position);
    const nul = message.content.indexOf("\u0000");
    if (nul !== -1) add(scrubbed, key(message.role, normalizeMessageContent(scrub(message.content.slice(0, nul)))), position);
    if (position % REPAIR_PAGE_SIZE === 0) await yieldToEventLoop();
  }
  return { messages, index: { raw, scrubbed, budget: WILDCARD_COMPARISONS_PER_RECORD * messages.length }, next: 0, aligned: true };
}

/** The first two remaining positions suffice to prove uniqueness or ambiguity. */
function remaining(positions: number[] | undefined, next: number): number[] {
  if (!positions) return [];
  let low = 0, high = positions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (positions[middle] < next) low = middle + 1;
    else high = middle;
  }
  return positions.slice(low, low + 2);
}

/** Prefer the live prefix, as capture does; otherwise require unique file-order matches, as rebuild does. */
async function alignmentFor(store: ConversationStore, sessionId: string, read: TranscriptDelta, scrub: Scrub): Promise<Alignment> {
  let offset = 0;
  if (read.eventTimeCandidates) for await (const page of store.sessionMessagePages(sessionId, REPAIR_PAGE_SIZE)) {
    const aligned = page.every((message, index) => matches(message, read.messages[offset + index], scrub));
    await yieldToEventLoop();
    if (!aligned) return fileOrderAlignment(read.eventTimeCandidates, scrub);
    offset += page.length;
  }
  return { messages: read.messages, next: 0, aligned: true };
}

async function matchedRecord(state: Alignment, stored: MessageRecord, position: number, scrub: Scrub): Promise<ParsedMessage | undefined> {
  // Every stored row, including one with a known time, verifies the prefix in order.
  // A mismatch permanently stops positional alignment across pages and clear boundaries.
  if (!state.aligned) return undefined;
  let found = position;
  if (state.index) {
    const normalized = normalizeMessageContent(scrub(stored.content));
    if (normalized.includes(REDACTION_MARKER)) {
      // Removed redaction rules allow wildcard matches that equality cannot index.
      // Bound their total comparisons per session; exhaustion leaves the suffix unknown.
      found = await uniqueWildcardPosition(state, stored, scrub);
    } else found = uniqueIndexedPosition(state, stored, normalized);
  }
  const record = state.messages[found];
  state.aligned = matches(stored, record, scrub);
  state.next = found + 1;
  return state.aligned ? record : undefined;
}

function uniqueIndexedPosition(state: Alignment, stored: MessageRecord, normalized: string): number {
  const candidates = new Set([
    ...remaining(state.index!.raw.get(key(stored.role, stored.content)), state.next),
    ...remaining(state.index!.scrubbed.get(key(stored.role, normalized)), state.next),
  ]);
  return candidates.size === 1 ? candidates.values().next().value! : -1;
}

async function uniqueWildcardPosition(state: Alignment, stored: MessageRecord, scrub: Scrub): Promise<number> {
  let found = -1;
  for (let index = state.next; index < state.messages.length; index++) {
    if (index % REPAIR_PAGE_SIZE === 0) await yieldToEventLoop();
    if (state.index!.budget-- <= 0) return -1;
    if (!matches(stored, state.messages[index], scrub)) continue;
    if (found !== -1) return -1;
    found = index;
  }
  return found;
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
  const read: TranscriptDelta = path ? await source.read(path, undefined, { ...input, scrub, eventTimeRepair: true })
    : { messages: [], sourceOffset: 0, backfillModels() {} };
  // BEGIN IMMEDIATE takes the write lock even with nothing to insert, so a session without declarations skips it.
  if (read.sessionUrlDeclarations?.length) await conversations.withTransaction(() => {
    if (!new WorkerStore(db).excluded(input.sessionId)) recordSessionWebUrls(db, input.sessionId, read.sessionUrlDeclarations ?? []);
  });
  const alignment = await alignmentFor(conversations, input.sessionId, read, scrub);
  let updated = 0, unknown = 0;
  const ids = new Set<number>();
  let offset = 0;
  for await (const page of conversations.sessionMessagePages(input.sessionId, REPAIR_PAGE_SIZE)) {
    const repairs: Parameters<ConversationStore["backfillMessageEventTimes"]>[0][number][] = [];
    for (const [index, message] of page.entries()) {
      ids.add(message.conversationId);
      const record = await matchedRecord(alignment, message, offset + index, scrub);
      // A transcript time is the record's own; it replaces a commit anchor, never the reverse.
      if (message.eventAt && message.eventTimeSource !== "commit") continue;
      if (record?.eventAt) repairs.push({ messageId: message.messageId, content: message.content, role: message.role, eventAt: record.eventAt });
      else if (!message.eventAt) unknown++;
    }
    updated += await conversations.withTransaction(() => conversations.backfillMessageEventTimes(repairs));
    await yieldToEventLoop();
    offset += page.length;
  }
  // Also repairs bounds on an idempotent retry after an interrupted bounds pass.
  const summaries = new SummaryStore(db);
  for (const id of ids) await summaries.recomputeTimeBounds(id);
  return { updated, unknown };
}
