import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { extractCodexTurnModels, type CodexSessionMeta } from "./codex-transcript.js";
import { readCodexTranscriptDelta, type CodexTranscriptCursor, type CodexTranscriptDelta } from "./codex-transcript-reader.js";
import { loadTranscriptCursor, saveTranscriptCursor } from "./db/transcript-cursor.js";
import { claudeTranscriptPath, isSafeTranscriptPath, projectId } from "./daemon/project.js";
import type { EventsDb } from "./hooks/events-db.js";
import {
  extractOmpTurnModels,
  loadOmpArchive,
  selectOmpLiveSegments,
  type OmpSessionMeta,
  type ParsedOmpTranscriptRecord,
} from "./omp-transcript.js";
import { readOmpTranscriptDelta, type OmpTranscriptCursor, type OmpTranscriptDelta } from "./omp-transcript-reader.js";
import { matchesUnderRedaction } from "./scrub.js";
import type { SessionClient } from "./session-client.js";
import { discoverSubagentTranscripts, type DiscoveredSubagentTranscript } from "./subagent-attribution.js";
import { extractToolUseModels, parseTranscript, type ParsedMessage } from "./transcript.js";

/**
 * The transcript-source seam: one interface answering "what does this
 * transcript hold beyond what is already stored", with an adapter per session
 * client (src/session-client.ts). Each adapter owns its own delta model —
 * Claude re-parses the file and slices at the stored count, verifying the
 * stored prefix once compaction has written into the session; Codex resumes from
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
  storedMessages(offset?: number): Promise<Array<{ role: string; content: string }>>;
  /** Fingerprints raw stored rows and conversation identity up to `count`, excluding compaction events. */
  prefixFingerprint?(count: number): Promise<string>;
  /** The adapter's resume checkpoint as last persisted, unverified. Opaque: only the adapter that wrote it may read it. */
  checkpoint?: unknown;
  /**
   * True when compaction has written its event rows into the session and every conversation
   * of it was captured by the current transcript parser: a Claude slice at the stored count is
   * then trusted only after the stored history is verified as the transcript's prefix.
   */
  verifyAfterCompaction?(): Promise<boolean>;
}

export interface ReadContext extends TranscriptLocator {
  /** The current redaction rules, applied to both sides of a prefix comparison. */
  scrub(text: string): string;
  /** Stable identity of the current redaction rules. Without one, prefix validation is not memoized. */
  redactionKey?: string;
}

/**
 * A point where the harness cleared the model's context inside one session file: the
 * messages from `at` on (an index into the delta's `messages`) belong to a new conversation,
 * opened by the transcript entry `entryId`. A clear with nothing after it sits at the end.
 */
export interface ConversationBoundary {
  entryId: string;
  at: number;
}

export interface TranscriptDelta {
  /** Messages from `sourceOffset` onwards. */
  messages: ParsedMessage[];
  /** The clears among `messages`, in order. Absent for a client whose clear starts a new session instead. */
  boundaries?: ConversationBoundary[];
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

type ClaudePrefixMemo = { count: number; stored: string; transcript: string; file: string; redaction: string };
// Routes reopen connections between captures; fingerprints identify the database and its rows.
const claudePrefixes = new Map<string, ClaudePrefixMemo>();
const MAX_CLAUDE_PREFIXES = 128;

function transcriptPrefixFingerprint(messages: ParsedMessage[], count: number): string {
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(JSON.stringify([messages[i].role, messages[i].content]));
  return hash.digest("hex");
}

async function validateClaudePrefix(path: string, stored: StoredTranscript, messages: ParsedMessage[], ctx: ReadContext): Promise<void> {
  if (!stored.prefixFingerprint || ctx.redactionKey === undefined) {
    return validateTranscriptRecovery(stored, messages, ctx, "Claude");
  }
  const key = JSON.stringify([ctx.cwd, ctx.sessionId, path]);
  const prior = claudePrefixes.get(key);
  // A failed validation must never leave a previously accepted memo available.
  claudePrefixes.delete(key);
  const stat = statSync(path);
  const file = `${stat.dev}:${stat.ino}`;
  let offset = 0;
  let storedHash: string | undefined;
  if (prior && prior.count <= stored.storedCount && prior.count <= messages.length &&
      prior.file === file && prior.redaction === ctx.redactionKey &&
      prior.transcript === transcriptPrefixFingerprint(messages, prior.count)) {
    storedHash = await stored.prefixFingerprint(prior.count);
    if (storedHash === prior.stored) offset = prior.count;
  }
  // Fingerprint before the comparison: never bless rows changed after it has read them.
  const fingerprint = offset === stored.storedCount && storedHash !== undefined
    ? storedHash : await stored.prefixFingerprint(stored.storedCount);
  await validateTranscriptRecovery(stored, messages, ctx, "Claude", offset);
  claudePrefixes.set(key, {
    count: stored.storedCount,
    stored: fingerprint,
    transcript: transcriptPrefixFingerprint(messages, stored.storedCount),
    file, redaction: ctx.redactionKey,
  });
  if (claudePrefixes.size > MAX_CLAUDE_PREFIXES) claudePrefixes.delete(claudePrefixes.keys().next().value!);
}

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
  async read(path, stored, ctx) {
    const storedCount = stored?.storedCount ?? 0;
    const messages = parseTranscript(path);
    // A fresh read, including the rebuild path, cannot reuse a pre-rebuild validation.
    if (!stored) claudePrefixes.delete(JSON.stringify([ctx.cwd, ctx.sessionId, path]));
    // Before compaction stopped counting its own event rows, a capture after a compaction
    // sliced past as many transcript messages as the session held event rows, and the
    // corrected count then re-stored its tail. Such a history is not a prefix of the
    // transcript; appending to it would repeat the damage, so capture stalls until a rebuild.
    if (stored && await stored.verifyAfterCompaction?.()) {
      try {
        await validateClaudePrefix(path, stored, messages, ctx);
      } catch (error) {
        if (!(error instanceof TranscriptSourceError)) throw error;
        throw new TranscriptSourceError(
          `${error.message}. A session captured after a compaction by an earlier lcm can hold skipped and repeated messages: ` +
            "preview with `lcm import --provider claude --rebuild --dry-run`, then repair it with `lcm import --provider claude --rebuild --yes`",
        );
      }
    }
    return {
      messages: messages.slice(storedCount),
      sourceOffset: storedCount,
      backfillModels(events, sessionId) {
        if (!events.hasUnfilledModels(sessionId, "claude")) return;
        events.backfillToolCallModels(sessionId, extractToolUseModels(path), "claude");
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

/**
 * A full re-read is trusted only while its prefix, under the current redaction rules, is
 * what was stored. The label names the harness whose transcript the caller was reading.
 * OMP does not use it: a rewind can leave stored history that is not a prefix of the
 * file's live path (`ompMessagesAfterStored`).
 */
async function validateTranscriptRecovery(
  stored: StoredTranscript, messages: ParsedMessage[], ctx: ReadContext, label: string, offset = 0,
): Promise<void> {
  if (messages.length < stored.storedCount) {
    throw new TranscriptSourceError(`${label} transcript is shorter than stored history; restore the full transcript before retrying`);
  }
  const previous = await stored.storedMessages(offset);
  if (previous.length !== stored.storedCount - offset) throw new TranscriptSourceError(`Stored ${label} history changed during recovery`);
  for (const [index, prior] of previous.entries()) {
    const message = messages[offset + index];
    if (message.role !== prior.role || !storedContentMatches(prior.content, message.content, ctx.scrub)) {
      throw new TranscriptSourceError(`${label} transcript prefix differs from stored history; check the original transcript and redaction settings before retrying`);
    }
  }
}

/** Equal under the current redaction rules, or equal but for spans a pattern since removed had redacted. Scrubs only when the texts differ. */
function storedContentMatches(stored: string, current: string, scrub: (text: string) => string): boolean {
  if (stored === current) return true;
  const storedNow = scrub(stored);
  const currentNow = scrub(current);
  return storedNow === currentNow || matchesUnderRedaction(storedNow, currentNow);
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
    if (!delta.resumed && stored) await validateTranscriptRecovery(stored, delta.messages, ctx, "Codex");
    return {
      messages: delta.messages,
      sourceOffset: delta.resumed && prior ? prior.messageCount : 0,
      checkpoint: delta.cursor,
      backfillModels(events, sessionId) {
        if (!events.hasUnfilledTurnModels(sessionId, "codex")) return;
        events.backfillTurnModels(sessionId, extractCodexTurnModels(path), "codex");
      },
    };
  },
  loadCheckpoint(db, conversationId, transcriptPath) {
    return loadTranscriptCursor(db, conversationId, transcriptPath);
  },
  saveCheckpoint(db, conversationId, transcriptPath, checkpoint) {
    // The checkpoint is this adapter's own token; the cast is the adapter boundary.
    saveTranscriptCursor(db, { conversationId, transcriptPath, cursor: checkpoint as CodexTranscriptCursor });
  },
};

/** An OMP session file the adapter will not read: wrong project, session, or path. */
function validateOmpMetadata(meta: OmpSessionMeta, ctx: ReadContext): void {
  if (!meta.cwd) throw new TranscriptSourceError("OMP transcript metadata is missing a cwd");
  if (projectId(meta.cwd) !== projectId(ctx.cwd)) throw new TranscriptSourceError("OMP transcript cwd does not match requested project");
  if (meta.id ? meta.id !== ctx.sessionId : ctx.source !== "import") {
    throw new TranscriptSourceError("OMP transcript session id does not match request");
  }
}

/**
 * A full OMP re-read against stored history: the live-path messages of the entries stored
 * history does not account for yet, and the clears among them. A clear inside stored history
 * is never reported again: that history is not split after the fact.
 *
 * Stored history is each earlier delta's live path, so it holds the file's messages in order
 * but not necessarily a prefix of them: a rewind may have abandoned a stored turn, or one
 * skipped before it was captured. Comparisons apply the current redaction rules. Stored
 * history that is a prefix of the file's live path continues that path, so a message repeated
 * on an abandoned branch is not matched there and stored twice. Otherwise the earliest
 * in-order match of stored history ends at the entry holding its last message, and the
 * entries after it are selected as one delta. History the file does not hold in order is refused.
 */
async function ompMessagesAfterStored(
  stored: StoredTranscript, records: readonly ParsedOmpTranscriptRecord[], ctx: ReadContext,
): Promise<{ messages: ParsedMessage[]; boundaries: ConversationBoundary[] }> {
  const previous = await stored.storedMessages();
  if (previous.length !== stored.storedCount) throw new TranscriptSourceError("Stored OMP history changed during recovery");
  const same = (candidate: ParsedMessage, prior: { role: string; content: string }) =>
    candidate.role === prior.role && ctx.scrub(candidate.content) === ctx.scrub(prior.content);
  const live = selectOmpLiveSegments(records);
  if (live.messages.length >= previous.length && previous.every((prior, index) => same(live.messages[index], prior))) {
    const after = previous.length;
    return {
      messages: live.messages.slice(after),
      boundaries: live.boundaries.filter(({ at }) => at >= after).map((boundary) => ({ ...boundary, at: boundary.at - after })),
    };
  }
  return selectOmpLiveSegments(records.slice(ompStoredBoundary(previous, records, same)));
}

/** The index after the entry holding the last stored message, in the earliest in-order match. */
function ompStoredBoundary(
  previous: ReadonlyArray<{ role: string; content: string }>,
  records: readonly ParsedOmpTranscriptRecord[],
  same: (candidate: ParsedMessage, prior: { role: string; content: string }) => boolean,
): number {
  const inFileOrder = records.flatMap(({ message }, index) =>
    (Array.isArray(message) ? message : message ? [message] : []).map((candidate) => ({ candidate, after: index + 1 })));
  let matched = 0;
  let boundary = 0;
  for (const { candidate, after } of inFileOrder) {
    if (matched === previous.length) break;
    if (!same(candidate, previous[matched])) continue;
    matched++;
    boundary = after;
  }
  if (matched < previous.length) {
    throw new TranscriptSourceError("OMP transcript does not hold the stored history in order; check the original transcript and redaction settings before retrying");
  }
  return boundary;
}

/**
 * An archive is a single gzip member, not an append-only file: the
 * byte-cursor reader's identity checks do not apply, and it carries no
 * cursor to resume from. It is always read in full, and its live path is
 * selected and reconciled against stored history the same way a live delta's
 * `records` are (`selectOmpLiveMessages`, `ompMessagesAfterStored`), so an
 * archived and a live transcript of the same session give the same stored
 * conversation.
 *
 * `loadOmpArchive` decompresses the file exactly once and hands back meta,
 * records, and a lazy model-backfill map derived from that single decode —
 * gunzip is the costly step; a read must not repeat it for metadata, the
 * record list, and a possible model backfill separately.
 */
async function readOmpArchive(path: string, stored: StoredTranscript | undefined, ctx: ReadContext): Promise<TranscriptDelta> {
  const archive = loadOmpArchive(path);
  validateOmpMetadata(archive?.meta ?? {}, ctx);
  const records = archive?.records ?? [];
  const backfillModels: TranscriptDelta["backfillModels"] = (events, sessionId) => {
    if (!events.hasUnfilledModels(sessionId, "omp")) return;
    events.backfillToolCallModels(sessionId, archive?.turnModels() ?? new Map(), "omp");
  };
  if (stored) {
    const { messages, boundaries } = await ompMessagesAfterStored(stored, records, ctx);
    return { messages, boundaries, sourceOffset: stored.storedCount, backfillModels };
  }
  const { messages, boundaries } = selectOmpLiveSegments(records, true);
  return { messages, boundaries, sourceOffset: 0, backfillModels };
}

const ompSource: TranscriptSource = {
  client: "omp",
  mayRecoverTail: true,
  locate(input) {
    // The OMP hook and the importer always know the session file; unlike Claude,
    // there is nothing derivable from the session id alone.
    if (!input.transcriptPath) return undefined;
    const safe = isSafeTranscriptPath(input.transcriptPath, input.cwd, "omp");
    if (!safe) throw new TranscriptSourceError("OMP transcript path is not allowed");
    if (!existsSync(safe)) throw new TranscriptSourceError("OMP transcript is unreadable");
    return safe;
  },
  async read(path, stored, ctx) {
    if (path.endsWith(".jsonl.gz")) return readOmpArchive(path, stored, ctx);

    // The checkpoint is this adapter's own token; the cast is the adapter boundary.
    const cursor = stored?.checkpoint as OmpTranscriptCursor | undefined;
    // A cursor is trusted only while it accounts for exactly the stored messages.
    const prior = cursor && stored && cursor.messageCount === stored.storedCount ? cursor : undefined;
    let delta: OmpTranscriptDelta;
    try {
      delta = await readOmpTranscriptDelta(path, { cursor: prior, includeTrailingRecord: ctx.source === "import" });
    } catch (error) {
      throw new TranscriptSourceError(error instanceof Error ? error.message : "invalid transcript");
    }
    validateOmpMetadata(delta.sessionMeta, ctx);
    const backfillModels: TranscriptDelta["backfillModels"] = (events, sessionId) => {
      if (!events.hasUnfilledModels(sessionId, "omp")) return;
      events.backfillToolCallModels(sessionId, extractOmpTurnModels(path), "omp");
    };
    if (!delta.resumed && stored) {
      const { messages, boundaries } = await ompMessagesAfterStored(stored, delta.records ?? [], ctx);
      const checkpoint = { ...delta.cursor, messageCount: stored.storedCount + messages.length };
      return { messages, boundaries, sourceOffset: stored.storedCount, checkpoint, backfillModels };
    }
    return {
      messages: delta.messages,
      // The reader selected `messages` from these same records; this adds where the clears fall.
      boundaries: selectOmpLiveSegments(delta.records ?? []).boundaries,
      sourceOffset: delta.resumed && prior ? prior.messageCount : 0,
      checkpoint: delta.cursor,
      backfillModels,
    };
  },
  loadCheckpoint(db, conversationId, transcriptPath) {
    return loadTranscriptCursor(db, conversationId, transcriptPath);
  },
  saveCheckpoint(db, conversationId, transcriptPath, checkpoint) {
    // The checkpoint is this adapter's own token; the cast is the adapter boundary.
    saveTranscriptCursor(db, { conversationId, transcriptPath, cursor: checkpoint as OmpTranscriptCursor });
  },
};

/** The adapter for a client; an unknown client reads Claude Code transcripts. */
export function transcriptSource(client: string | undefined): TranscriptSource {
  if (client === "codex") return codexSource;
  if (client === "omp") return ompSource;
  return claudeSource;
}
