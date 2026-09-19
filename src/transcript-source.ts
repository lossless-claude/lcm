import { existsSync } from "node:fs";
import { extractCodexTurnModels, type CodexSessionMeta } from "./codex-transcript.js";
import { readCodexTranscriptDelta, type CodexTranscriptCursor } from "./codex-transcript-reader.js";
import { claudeTranscriptPath, isSafeTranscriptPath, projectId } from "./daemon/project.js";
import type { EventsDb } from "./hooks/events-db.js";
import { extractToolUseModels, parseTranscript, type ParsedMessage } from "./transcript.js";

/**
 * The transcript-source seam: one interface answering "what does this
 * transcript hold beyond what is already stored", with an adapter per harness.
 * Each adapter owns its own delta model — Claude re-parses the file and slices
 * at the stored count; Codex resumes from a byte-offset cursor and verifies the
 * stored prefix when it cannot — and its own validation rules. `SessionCapture`
 * (src/capture.ts) is the only caller; no route selects an adapter itself.
 */

export type TranscriptClient = "claude" | "codex";

/** What is known about a session's transcript before it is read. */
export interface TranscriptLocator {
  sessionId: string;
  /** The validated project cwd. */
  cwd: string;
  /** The caller's transcript path; Claude derives one from the session when absent. */
  transcriptPath?: string;
  source?: "live" | "import";
}

/** What is already stored for the session, as an adapter needs it to find the delta. */
export interface StoredTranscript {
  storedCount: number;
  /** The stored prefix in order, for an adapter that must verify it before trusting a full re-read. */
  storedMessages(): Array<{ role: string; content: string }>;
  /** The Codex cursor persisted with the last write, unverified. */
  codexCursor?: CodexTranscriptCursor;
}

export interface ReadContext extends TranscriptLocator {
  /** The current redaction rules, applied to both sides of a prefix comparison. */
  scrub(text: string): string;
}

export interface TranscriptDelta {
  /** Messages from `sourceOffset` onwards. */
  messages: ParsedMessage[];
  /** How many leading messages `messages` omits because they are stored. */
  sourceOffset: number;
  /** Persisted in the same transaction as the messages it accounts for. */
  codexCursor?: CodexTranscriptCursor;
  /** Fills the model on the session's events whose hook payload could not carry one; scans the transcript only when rows wait. */
  backfillModels(events: EventsDb, sessionId: string): void;
}

export interface TranscriptSource {
  readonly client: TranscriptClient;
  /** The file this session reads from, validated; undefined when there is none. Throws for a path the adapter refuses. */
  locate(input: TranscriptLocator): string | undefined;
  read(path: string, stored: StoredTranscript | undefined, ctx: ReadContext): Promise<TranscriptDelta>;
}

/** A transcript the adapter refuses to read: the caller's request is wrong, not the daemon. */
export class TranscriptSourceError extends Error {}

const claudeSource: TranscriptSource = {
  client: "claude",
  locate(input) {
    // A caller that knows only the session (the function-hooks module) gets Claude Code's
    // own transcript location; it still has to pass isSafeTranscriptPath like any other.
    const suppliedPath = input.transcriptPath;
    const path = suppliedPath ?? claudeTranscriptPath(input.cwd, input.sessionId);
    if (!path) return undefined;
    const safe = isSafeTranscriptPath(path, input.cwd, "claude");
    if (!safe && suppliedPath) throw new TranscriptSourceError("Claude transcript path is not allowed");
    return safe && existsSync(safe) ? safe : undefined;
  },
  async read(path, stored) {
    const storedCount = stored?.storedCount ?? 0;
    return {
      messages: parseTranscript(path).slice(storedCount),
      sourceOffset: storedCount,
      backfillModels(events, sessionId) {
        if (!events.hasUnfilledModels(sessionId)) return;
        events.backfillToolCallModels(sessionId, extractToolUseModels(path));
      },
    };
  },
};

function validateCodexMetadata(meta: CodexSessionMeta, ctx: ReadContext): void {
  if (!meta.cwd) throw new TranscriptSourceError("Codex transcript metadata is missing a cwd");
  if (projectId(meta.cwd) !== projectId(ctx.cwd)) throw new TranscriptSourceError("Codex transcript cwd does not match requested project");
  // A legacy transcript without an id is identified by its filename, which only an import knows.
  if (meta.id ? meta.id !== ctx.sessionId : ctx.source !== "import") {
    throw new TranscriptSourceError("Codex transcript session id does not match request");
  }
}

/** A full re-read is trusted only while its prefix, under the current redaction rules, is what was stored. */
function validateCodexRecovery(stored: StoredTranscript, messages: ParsedMessage[], ctx: ReadContext): void {
  if (messages.length < stored.storedCount) {
    throw new TranscriptSourceError("Codex transcript is shorter than stored history; restore the full transcript before retrying");
  }
  const previous = stored.storedMessages();
  if (previous.length !== stored.storedCount) throw new TranscriptSourceError("Stored Codex history changed during recovery");
  for (const [index, prior] of previous.entries()) {
    const message = messages[index];
    if (message.role !== prior.role || ctx.scrub(message.content) !== ctx.scrub(prior.content)) {
      throw new TranscriptSourceError("Codex transcript prefix differs from stored history; check the original transcript and redaction settings before retrying");
    }
  }
}

const codexSource: TranscriptSource = {
  client: "codex",
  locate(input) {
    if (!input.transcriptPath) return undefined;
    const safe = isSafeTranscriptPath(input.transcriptPath, input.cwd, "codex");
    if (!safe) throw new TranscriptSourceError("Codex transcript path is not allowed");
    if (!existsSync(safe)) throw new TranscriptSourceError("Codex transcript is unreadable");
    return safe;
  },
  async read(path, stored, ctx) {
    // A cursor is trusted only while it accounts for exactly the stored messages.
    const prior = stored?.codexCursor && stored.codexCursor.messageCount === stored.storedCount ? stored.codexCursor : undefined;
    let delta: Awaited<ReturnType<typeof readCodexTranscriptDelta>>;
    try {
      delta = await readCodexTranscriptDelta(path, { cursor: prior, includeTrailingRecord: ctx.source === "import" });
    } catch (error) {
      throw new TranscriptSourceError(error instanceof Error ? error.message : "invalid transcript");
    }
    validateCodexMetadata(delta.sessionMeta, ctx);
    if (!delta.resumed && stored) validateCodexRecovery(stored, delta.messages, ctx);
    return {
      messages: delta.messages,
      sourceOffset: delta.resumed && prior ? prior.messageCount : 0,
      codexCursor: delta.cursor,
      backfillModels(events, sessionId) {
        if (!events.hasUnfilledCodexModels(sessionId)) return;
        events.backfillCodexTurnModels(sessionId, extractCodexTurnModels(path));
      },
    };
  },
};

/** The adapter for a client; anything that is not Codex reads Claude Code transcripts. */
export function transcriptSource(client: string | undefined): TranscriptSource {
  return client === "codex" ? codexSource : claudeSource;
}
