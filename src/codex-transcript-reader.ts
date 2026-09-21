/**
 * Incremental reader for append-only Codex JSONL transcripts: the format
 * adapter over the shared byte-cursor reader (src/jsonl-transcript-reader.ts).
 *
 * The fingerprint version string is part of the persisted cursor; it must not
 * change without invalidating every stored Codex cursor.
 */

import type { CodexSessionMeta } from "./codex-transcript.js";
import { decodeCodexTranscriptUtf8, parseCodexTranscriptRecord } from "./codex-transcript.js";
import type { ParsedMessage } from "./transcript.js";
import { readJsonlTranscriptDelta, type JsonlTranscriptCursor, type ReadJsonlTranscriptDeltaOptions } from "./jsonl-transcript-reader.js";

export const CODEX_FINGERPRINT_VERSION = "codex-transcript-prefix-v1";

export type CodexTranscriptCursor = JsonlTranscriptCursor;
export type ReadCodexTranscriptDeltaOptions = ReadJsonlTranscriptDeltaOptions;
export type CodexTranscriptDelta = {
  messages: ParsedMessage[];
  cursor: CodexTranscriptCursor;
  resumed: boolean;
  sessionMeta: CodexSessionMeta;
};

const codexFormat = {
  label: "Codex",
  fingerprintVersion: CODEX_FINGERPRINT_VERSION,
  decodeUtf8: decodeCodexTranscriptUtf8,
  parseRecord: (record: string) => parseCodexTranscriptRecord(record),
};

/**
 * Read only the suffix added after a durable Codex transcript cursor.
 * Semantics live in the shared reader; this adapter fixes the format.
 */
export async function readCodexTranscriptDelta(
  transcriptPath: string,
  options: ReadCodexTranscriptDeltaOptions,
): Promise<CodexTranscriptDelta> {
  return readJsonlTranscriptDelta<CodexSessionMeta>(transcriptPath, codexFormat, options);
}
