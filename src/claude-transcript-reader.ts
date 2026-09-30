import { readJsonlTranscriptDelta, type JsonlTranscriptCursor, type ReadJsonlTranscriptDeltaOptions } from "./jsonl-transcript-reader.js";
import { CLAUDE_PARSER_SHAPE, parseClaudeTranscriptRecord } from "./transcript.js";

export interface ClaudeTranscriptCursor extends JsonlTranscriptCursor {
  /** A cursor without the validation's redaction identity cannot bypass the prefix guard. */
  redactionKey: string;
  /** Only this read's pairs, persisted with the cursor; never transcript content. */
  toolUseModels?: ReadonlyMap<string, string>;
  /** A recovery read replaces the index; an append only adds its new pairs. */
  replaceToolUseModels?: boolean;
  /** An existing session's enrollment compared only its previously stored prefix. */
  validatedCount?: number;
  /** Scrubbed, normalized digest of the tail written during that enrollment. */
  pendingFingerprint?: string;
}

/** Claude's parser over the common byte reader, including its best-effort malformed-line filtering. */
export async function readClaudeTranscriptDelta(path: string, options: ReadJsonlTranscriptDeltaOptions) {
  const models = new Map<string, string>();
  const delta = await readJsonlTranscriptDelta(path, {
    label: "Claude",
    fingerprintVersion: `claude-transcript-prefix-v1:${CLAUDE_PARSER_SHAPE}`,
    hasSessionMeta: false,
    decodeUtf8: (bytes) => Buffer.from(bytes).toString("utf8"),
    isCompleteTrailingRecord: (record) => {
      try { JSON.parse(record); return true; } catch { return false; }
    },
    parseRecord: (record) => {
      const parsed = parseClaudeTranscriptRecord(record);
      for (const [id, model] of parsed.toolUseModels) models.set(id, model);
      return parsed;
    },
  }, options);
  return { ...delta, toolUseModels: models };
}
