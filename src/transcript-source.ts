import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { extractCodexTurnModels, type CodexSessionMeta } from "./codex-transcript.js";
import { readCodexTranscriptDelta, type CodexTranscriptCursor, type CodexTranscriptDelta } from "./codex-transcript-reader.js";
import { loadCodexCursor, saveCodexCursor } from "./db/codex-cursor.js";
import { claudeTranscriptPath, isSafeTranscriptPath, projectId } from "./daemon/project.js";
import type { EventsDb } from "./hooks/events-db.js";
import type { SessionClient } from "./session-client.js";
import { discoverSubagentTranscripts, type DiscoveredSubagentTranscript } from "./subagent-attribution.js";
import { extractToolUseModels, parseTranscript, type ParsedMessage } from "./transcript.js";

/**
 * The transcript-source seam: one interface answering "what does this
 * transcript hold beyond what is already stored", with an adapter per session
 * client (src/session-client.ts). Each adapter owns its own delta model —
 * Claude re-parses the file and slices at the stored count; Codex resumes from
 * a byte-offset cursor and verifies the stored prefix when it cannot — its own
 * validation rules, and its own resume checkpoint, opaque to callers. It also
 * states the capabilities the ingest route forks on, so no shared code names a
 * client. `SessionCapture` (src/capture.ts) is the only reader; no route
 * selects an adapter itself.
 */

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
  storedMessages(): Promise<Array<{ role: string; content: string }>>;
  /** The adapter's resume checkpoint as last persisted, unverified. Opaque: only the adapter that wrote it may read it. */
  checkpoint?: unknown;
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
  /** The adapter's resume checkpoint; persisted in the same transaction as the messages it accounts for. Opaque to capture. */
  checkpoint?: unknown;
  /** Fills the model on the session's events whose hook payload could not carry one; scans the transcript only when rows wait. */
  backfillModels(events: EventsDb, sessionId: string): void;
}

export interface TranscriptSource {
  readonly client: SessionClient;
  /** True when a read may recover transcript content the live hook path could not deliver — such a client must never take a "session complete" shortcut. */
  readonly mayRecoverTail: boolean;
  /** The file this session reads from, validated; undefined when there is none. Throws for a path the adapter refuses. */
  locate(input: TranscriptLocator): string | undefined;
  read(path: string, stored: StoredTranscript | undefined, ctx: ReadContext): Promise<TranscriptDelta>;
  /** Discovers the subagent transcripts dispatched by one session. Absent when the client has no subagent transcripts. */
  discoverSubagents?(cwd: string, sessionId: string): DiscoveredSubagentTranscript[];
  /** The checkpoint persisted with the session's last write, for `read` to resume from. Absent when the adapter keeps none. */
  loadCheckpoint?(db: DatabaseSync, conversationId: number, transcriptPath: string): unknown;
  /** Persists a delta's checkpoint. Called by capture inside the message-append transaction, so a crash leaves neither behind. */
  saveCheckpoint?(db: DatabaseSync, conversationId: number, transcriptPath: string, checkpoint: unknown): void;
}

/** A transcript the adapter refuses to read: the caller's request is wrong, not the daemon. */
export class TranscriptSourceError extends Error {}

const claudeSource: TranscriptSource = {
  client: "claude",
  mayRecoverTail: false,
  discoverSubagents(cwd, sessionId) {
    const transcriptPath = claudeTranscriptPath(cwd, sessionId);
    return transcriptPath ? discoverSubagentTranscripts(join(dirname(transcriptPath), sessionId)) : [];
  },
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
async function validateCodexRecovery(stored: StoredTranscript, messages: ParsedMessage[], ctx: ReadContext): Promise<void> {
  if (messages.length < stored.storedCount) {
    throw new TranscriptSourceError("Codex transcript is shorter than stored history; restore the full transcript before retrying");
  }
  const previous = await stored.storedMessages();
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
  mayRecoverTail: true,
  locate(input) {
    if (!input.transcriptPath) return undefined;
    const safe = isSafeTranscriptPath(input.transcriptPath, input.cwd, "codex");
    if (!safe) throw new TranscriptSourceError("Codex transcript path is not allowed");
    if (!existsSync(safe)) throw new TranscriptSourceError("Codex transcript is unreadable");
    return safe;
  },
  async read(path, stored, ctx) {
    // The checkpoint is this adapter's own token; the cast is the adapter boundary.
    const cursor = stored?.checkpoint as CodexTranscriptCursor | undefined;
    // A cursor is trusted only while it accounts for exactly the stored messages.
    const prior = cursor && stored && cursor.messageCount === stored.storedCount ? cursor : undefined;
    let delta: CodexTranscriptDelta;
    try {
      delta = await readCodexTranscriptDelta(path, { cursor: prior, includeTrailingRecord: ctx.source === "import" });
    } catch (error) {
      throw new TranscriptSourceError(error instanceof Error ? error.message : "invalid transcript");
    }
    validateCodexMetadata(delta.sessionMeta, ctx);
    if (!delta.resumed && stored) await validateCodexRecovery(stored, delta.messages, ctx);
    return {
      messages: delta.messages,
      sourceOffset: delta.resumed && prior ? prior.messageCount : 0,
      checkpoint: delta.cursor,
      backfillModels(events, sessionId) {
        if (!events.hasUnfilledCodexModels(sessionId)) return;
        events.backfillCodexTurnModels(sessionId, extractCodexTurnModels(path));
      },
    };
  },
  loadCheckpoint(db, conversationId, transcriptPath) {
    return loadCodexCursor(db, conversationId, transcriptPath);
  },
  saveCheckpoint(db, conversationId, transcriptPath, checkpoint) {
    // The checkpoint is this adapter's own token; the cast is the adapter boundary.
    saveCodexCursor(db, { conversationId, transcriptPath, cursor: checkpoint as CodexTranscriptCursor });
  },
};

/** The adapter for a client; anything that is not Codex reads Claude Code transcripts. */
export function transcriptSource(client: string | undefined): TranscriptSource {
  return client === "codex" ? codexSource : claudeSource;
}
