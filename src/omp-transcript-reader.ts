/**
 * Incremental reader for append-only OMP session files: the format adapter
 * over the shared byte-cursor reader (src/jsonl-transcript-reader.ts).
 */

import type { OmpSessionMeta, ParsedOmpTranscriptRecord } from "./omp-transcript.js";
import { decodeOmpTranscriptUtf8, parseOmpTranscriptRecord } from "./omp-transcript.js";
import type { ParsedMessage } from "./transcript.js";
import { readJsonlTranscriptDelta, type JsonlTranscriptCursor, type ReadJsonlTranscriptDeltaOptions } from "./jsonl-transcript-reader.js";

export const OMP_FINGERPRINT_VERSION = "omp-transcript-prefix-v1";

export type OmpTranscriptCursor = JsonlTranscriptCursor;
export type ReadOmpTranscriptDeltaOptions = ReadJsonlTranscriptDeltaOptions;
export type OmpTranscriptDelta = {
  messages: ParsedMessage[];
  cursor: OmpTranscriptCursor;
  resumed: boolean;
  sessionMeta: OmpSessionMeta;
};

const ompFormat = {
  label: "OMP",
  fingerprintVersion: OMP_FINGERPRINT_VERSION,
  decodeUtf8: decodeOmpTranscriptUtf8,
  parseRecord: (record: string): ParsedOmpTranscriptRecord => parseOmpTranscriptRecord(record),
};

/**
 * Read only the suffix added after a durable OMP transcript cursor.
 * Semantics live in the shared reader; this adapter fixes the format.
 */
export async function readOmpTranscriptDelta(
  transcriptPath: string,
  options: ReadOmpTranscriptDeltaOptions,
): Promise<OmpTranscriptDelta> {
  return readJsonlTranscriptDelta<OmpSessionMeta>(transcriptPath, ompFormat, options);
}
