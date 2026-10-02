import type { DatabaseSync } from "node:sqlite";
import { readCodexTranscriptDelta } from "./codex-transcript-reader.js";
import { projectId } from "./daemon/project.js";
import { readOmpTranscriptDelta } from "./omp-transcript-reader.js";
import { loadOmpArchive, selectOmpLiveMessages, type ParsedOmpTranscriptRecord } from "./omp-transcript.js";
import { compareStoredMessageContent, normalizeMessageContent } from "./message-content.js";
import { ConversationStore, type MessageRecord } from "./store/conversation-store.js";
import type { ParsedMessage } from "./transcript.js";

export type CutRepairClient = "codex" | "omp";
export interface CutRowRepairPlan {
  sessionId: string;
  client: CutRepairClient;
  kind: "aligned" | "repairable" | "ambiguous" | "unavailable";
  rows: Array<{ messageId: number; storedContent: string; content: string; eventAt?: string }>;
  reason?: string;
}

type RepairInput = {
  sessionId: string;
  cwd: string;
  client: CutRepairClient;
  transcriptPath?: string;
  scrub: (text: string) => string;
};

function messagesInFileOrder(records: readonly ParsedOmpTranscriptRecord[]): ParsedMessage[] {
  return records.flatMap(({ message }) => Array.isArray(message) ? message : message ? [message] : []);
}

function matches(stored: MessageRecord, current: ParsedMessage, scrub: (text: string) => string): boolean {
  if (stored.role !== current.role) return false;
  if (stored.content === current.content || stored.content === normalizeMessageContent(current.content)) return true;
  const nul = current.content.indexOf("\u0000");
  if (nul !== -1 && stored.content === current.content.slice(0, nul)) return true;
  return compareStoredMessageContent(stored.content, current.content, scrub) !== undefined;
}

/** Match a stored prefix by position; a rewind's non-live history needs an unambiguous in-order match. */
function align(
  stored: MessageRecord[], live: ParsedMessage[], records: readonly ParsedOmpTranscriptRecord[] | undefined,
  scrub: (text: string) => string,
): ParsedMessage[] | undefined {
  if (stored.length <= live.length && stored.every((row, index) => matches(row, live[index], scrub))) {
    return live.slice(0, stored.length);
  }
  if (!records) return undefined;
  const all = messagesInFileOrder(records);
  const aligned: ParsedMessage[] = [];
  let from = 0;
  for (const row of stored) {
    const candidates: number[] = [];
    for (let index = from; index < all.length; index++) {
      if (matches(row, all[index], scrub)) candidates.push(index);
    }
    // Repeated equal messages cannot establish which transcript position produced this row.
    if (candidates.length !== 1) return undefined;
    from = candidates[0] + 1;
    aligned.push(all[candidates[0]]);
  }
  return aligned;
}

/** Read the full transcript, then select only stored rows whose matched message is cut at its first NUL. */
export async function planCutRowRepair(db: DatabaseSync, input: RepairInput): Promise<CutRowRepairPlan> {
  const base = { sessionId: input.sessionId, client: input.client, rows: [] } as const;
  if (!input.transcriptPath) return { ...base, rows: [], kind: "unavailable", reason: "no transcript file" };
  const stored = await new ConversationStore(db).getSessionMessages(input.sessionId);
  if (stored.length === 0) return { ...base, rows: [], kind: "aligned" };
  let live: ParsedMessage[];
  let records: readonly ParsedOmpTranscriptRecord[] | undefined;
  let meta: { id?: string; cwd?: string };
  try {
    if (input.client === "codex") {
      const read = await readCodexTranscriptDelta(input.transcriptPath, { includeTrailingRecord: true });
      live = read.messages;
      meta = read.sessionMeta;
    } else if (input.transcriptPath.endsWith(".jsonl.gz")) {
      const read = loadOmpArchive(input.transcriptPath);
      if (!read) throw new Error("archive is unreadable");
      live = selectOmpLiveMessages(read.records, true);
      records = read.records;
      meta = read.meta ?? {};
    } else {
      const read = await readOmpTranscriptDelta(input.transcriptPath, { includeTrailingRecord: true });
      live = read.messages;
      records = read.records;
      meta = read.sessionMeta;
    }
  } catch {
    return { ...base, rows: [], kind: "unavailable", reason: "transcript is unreadable" };
  }
  if (meta.id && meta.id !== input.sessionId) return { ...base, rows: [], kind: "ambiguous", reason: "transcript session id differs" };
  if (!meta.cwd || projectId(meta.cwd) !== projectId(input.cwd)) {
    return { ...base, rows: [], kind: "ambiguous", reason: "transcript project differs" };
  }
  const hasNul = live.some((message) => message.content.includes("\u0000"))
    || records?.some(({ message }) => Array.isArray(message)
      ? message.some((part) => part.content.includes("\u0000"))
      : message?.content.includes("\u0000"));
  if (!hasNul) {
    return { ...base, rows: [], kind: "aligned" };
  }
  const aligned = align(stored, live, records, input.scrub);
  if (!aligned) return { ...base, rows: [], kind: "ambiguous", reason: "stored messages cannot be matched uniquely to transcript positions" };
  const rows = stored.flatMap((row, index) => {
    const message = aligned[index];
    return message.content.includes("\u0000") && compareStoredMessageContent(row.content, message.content, input.scrub) === "cut"
      ? [{ messageId: row.messageId, storedContent: row.content, content: normalizeMessageContent(input.scrub(message.content)), ...(message.eventAt ? { eventAt: message.eventAt } : {}) }]
      : [];
  });
  return { ...base, rows, kind: rows.length ? "repairable" : "aligned" };
}

/** Apply a freshly classified plan under the project's mutation lease. */
export function applyCutRowRepair(db: DatabaseSync, plan: CutRowRepairPlan): number {
  if (plan.kind !== "repairable") return 0;
  return new ConversationStore(db).repairCutMessageContent(plan.rows);
}
