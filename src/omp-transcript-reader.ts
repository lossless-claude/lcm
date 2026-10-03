/**
 * Incremental reader for append-only OMP session files: the format adapter
 * over the shared byte-cursor reader (src/jsonl-transcript-reader.ts). Each
 * delta keeps only its entries on the session's live path.
 */

import type { OmpSessionMeta, ParsedOmpTranscriptRecord } from "./omp-transcript.js";
import { decodeOmpTranscriptUtf8, parseOmpTranscriptRecord, selectOmpLiveMessages, selectOmpLiveSegments } from "./omp-transcript.js";
import type { TranscriptToolCall } from "./tool-calls.js";
import type { ParsedMessage } from "./transcript.js";
import { readJsonlTranscriptDelta, type JsonlTranscriptCursor, type ReadJsonlTranscriptDeltaOptions } from "./jsonl-transcript-reader.js";

export const OMP_FINGERPRINT_VERSION = "omp-transcript-prefix-v1";

export type OmpTranscriptCursor = JsonlTranscriptCursor;
export type ReadOmpTranscriptDeltaOptions = ReadJsonlTranscriptDeltaOptions;
export type OmpTranscriptDelta = {
  toolCalls: TranscriptToolCall[];
  messages: ParsedMessage[];
  cursor: OmpTranscriptCursor;
  resumed: boolean;
  sessionMeta: OmpSessionMeta;
  /** Every record the delta read, in file order, for a recovery scan to align with stored history. */
  records?: ParsedOmpTranscriptRecord[];
};

const ompFormat = {
  label: "OMP",
  fingerprintVersion: OMP_FINGERPRINT_VERSION,
  decodeUtf8: decodeOmpTranscriptUtf8,
  parseRecord: (record: string): ParsedOmpTranscriptRecord => parseOmpTranscriptRecord(record),
  selectMessages: selectOmpLiveMessages,
  selectToolCalls: (records: readonly ParsedOmpTranscriptRecord[]) => selectOmpLiveSegments(records).toolCalls,
};

/**
 * Read only the suffix added after a durable OMP transcript cursor.
 * Semantics live in the shared reader; this adapter fixes the format.
 */
export async function readOmpTranscriptDelta(
  transcriptPath: string,
  options: ReadOmpTranscriptDeltaOptions,
): Promise<OmpTranscriptDelta> {
  return readJsonlTranscriptDelta<OmpSessionMeta, ParsedOmpTranscriptRecord>(transcriptPath, ompFormat, options);
}
