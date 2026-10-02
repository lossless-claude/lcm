import { TIMELINE_SESSION_ID } from "./db/project-timeline.js";
import { WorkerStore } from "./store/worker-store.js";
import { discoverWorkerDescendant, discoveredWorkerDescendant } from "./worker-session.js";
import type { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { basename, sep } from "node:path";
import { EventsDb } from "./hooks/events-db.js";
import { eventsDbPathForProject } from "./db/events-path.js";
import type { LcmPaths } from "./lcm-paths.js";
import { upsertRedactionCounts } from "./db/redaction-stats.js";
import { invalidateClaudeTranscriptCursor } from "./db/transcript-cursor.js";
import { openStandaloneLcmConnection } from "./db/connection.js";
import { normalizeMessageContent } from "./message-content.js";
import { rememberSubagentGuard, subagentGuardFingerprint, terminalTranscriptGuard } from "./daemon/subagent-guard-failures.js";
import type { ScrubEngine } from "./scrub.js";
import {
  ConversationStore,
  type CreateMessageInput,
  type CreateMessagePartInput,
  type MessageRecord,
  type MessageRole,
  type SubagentAttributionInput,
} from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { recordSessionWebUrls } from "./store/session-url-store.js";
import { readSubagentAttribution } from "./subagent-attribution.js";
import { CLAUDE_PARSER_SHAPE, parseTranscript, transcriptEventTime, type MessagePart, type ParsedMessage, type SessionUrlDeclaration } from "./transcript.js";
import { clearConversationForRebuild, planSessionRebuild, type SessionRebuildPlan } from "./claude-rebuild.js";
import {
  transcriptSource,
  TranscriptSourceError,
  type ConversationBoundary,
  type StoredTranscript,
  type TranscriptLocator,
  type TranscriptSource,
} from "./transcript-source.js";

/**
 * Capture (see CONTEXT.md): the one writer of a session's transcript content.
 * Every route that lands messages in `messages` goes through `SessionCapture`,
 * so what counts as "already stored", how content is scrubbed, and which
 * sibling rows (`context_items`, `message_parts`, redaction counts, the
 * transcript adapter's resume checkpoint) accompany a message are decided in
 * exactly one place. It is also
 * the capture caller of the transcript-source seam (src/transcript-source.ts):
 * a route names the client and the session, and Capture picks the adapter.
 */

export type RedactionCounts = { gitleaks: number; builtIn: number; global: number; project: number };

/** Structured messages have no Claude parser provenance; a later transcript capture must verify them. */
export const STRUCTURED_INGEST_SHAPE = "structured";

export interface StoredSession {
  /** The session's newest conversation: the one a clear opened last, or its only one. */
  conversationId: number;
  /** Messages stored across every conversation of the session. */
  storedCount: number;
}

export interface CaptureInput {
  sessionUrlDeclarations?: SessionUrlDeclaration[];
  sessionId: string;
  cwd?: string;
  /** Transcript messages, from the first one or from `sourceOffset` onwards. Whatever is already stored is skipped. */
  messages: ParsedMessage[];
  /** Cursor sources use NULL, structured ingestion uses its own marker, and Claude uses the current parser shape. */
  parserShape?: string | null;
  /** The Claude adapter verified all stored messages against today's parse. */
  restampParserShape?: boolean;
  /** How many leading messages `messages` already omits (an adapter checkpoint resume). */
  sourceOffset?: number;
  /** Clears among `messages`: each opens a new conversation for the messages from its position on. */
  boundaries?: ConversationBoundary[];
  /** Transcript path; when `attribution` is absent and this is a subagent transcript, its sidecar supplies it. */
  transcriptPath?: string;
  /** The `/ingest` subagent path always passes the walker's; `/compact` and a direct `/ingest` of a subagent transcript may pass none. */
  attribution?: SubagentAttributionInput;
  /** The transcript adapter's opaque resume token; persisted in the same transaction as the messages it accounts for. */
  checkpoint?: unknown;
  /** Persists that token for the session's conversation; called inside the write transaction. */
  persistCheckpoint?: (db: DatabaseSync, conversationId: number) => void;
}

export interface CaptureResult {
  conversationId: number;
  records: MessageRecord[];
  totalCounts: RedactionCounts;
}

export interface TranscriptCaptureInput extends TranscriptLocator {
  /** Selects the adapter; anything that is not Codex reads Claude Code transcripts. */
  client?: string;
  attribution?: SubagentAttributionInput;
}

export interface TranscriptCaptureResult extends CaptureResult {
  verification?: { verified: boolean; complete: boolean; boundaryFound: boolean; boundaryScanExceeded?: boolean };
  /** The transcript that was read, as the adapter located it. */
  transcriptPath: string;
  /** Fills the model on the session's events whose hook payload could not carry one. */
  backfillModels(events: EventsDb): void;
}

/**
 * A subagent transcript lives under `<parent>/subagents/`, possibly nested
 * (`subagents/workflows/wf_<id>/`); the directory names the parent and the
 * sidecar the dispatch, as the walker in src/subagent-attribution.ts reads
 * them. Any other path is not a subagent transcript and carries no attribution.
 */
export function attributionFromTranscriptPath(transcriptPath: string): SubagentAttributionInput | undefined {
  const segments = transcriptPath.split(sep);
  const subagentsIndex = segments.lastIndexOf("subagents");
  if (subagentsIndex < 1) return undefined;
  return readSubagentAttribution(transcriptPath, segments[subagentsIndex - 1]);
}

/** A Claude transcript is `<session>.jsonl`; a Codex rollout ends in `-<session>.jsonl`. */
function transcriptNamesSession(transcriptPath: string, sessionId: string): boolean {
  const name = basename(transcriptPath);
  return name === `${sessionId}.jsonl` || name.endsWith(`-${sessionId}.jsonl`);
}

/**
 * True when `/session-complete` recorded the session and, given its transcript, the file was
 * not written to after that: a resumed Claude Code session appends to the same file, so a
 * transcript modified since completion (or one that cannot be stat'd) has to be read again.
 */
export function isSessionComplete(db: DatabaseSync, sessionId: string, transcriptPath?: string): boolean {
  const row = db.prepare("SELECT completed_at FROM session_ingest_log WHERE session_id = ?").get(sessionId) as
    { completed_at: string } | undefined;
  if (!row) return false;
  if (transcriptPath === undefined) return true;
  let modifiedMs: number;
  try {
    modifiedMs = statSync(transcriptPath).mtimeMs;
  } catch {
    return false;
  }
  return completedSinceModified(row.completed_at, modifiedMs);
}

/** Whether a `session_ingest_log.completed_at` is no earlier than the transcript's last modification. */
export function completedSinceModified(completedAt: string, modifiedMs: number): boolean {
  // `completed_at` is SQLite UTC text; a NaN parse compares false, so the file is read.
  return modifiedMs <= Date.parse(`${completedAt.replace(" ", "T")}Z`);
}

/** Records the session complete now; completing it again after a resume moves `completed_at` forward. */
export function markSessionComplete(db: DatabaseSync, sessionId: string, messageCount: number): void {
  db.prepare(
    "INSERT INTO session_ingest_log (session_id, message_count, completed_at) VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now')) " +
      "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count, completed_at = excluded.completed_at",
  ).run(sessionId, messageCount);
}

function toMessagePartInput(sessionId: string, part: MessagePart, ordinal: number): CreateMessagePartInput {
  return { sessionId, partType: part.type, ordinal, toolName: part.name, toolInput: part.args };
}

export class SessionCapture {
  /** The stores this capture writes through, on the same connection — a route reads back through them rather than opening a second pair. */
  readonly conversationStore: ConversationStore;
  readonly summaryStore: SummaryStore;

  constructor(
    private readonly db: DatabaseSync,
    private readonly projectId: string,
    private readonly scrubber: ScrubEngine,
    private readonly paths?: LcmPaths,
  ) {
    this.conversationStore = new ConversationStore(db);
    this.summaryStore = new SummaryStore(db);
  }

  /** The session's newest conversation and how many messages the session has stored, or undefined before its first write. */
  async stored(sessionId: string): Promise<StoredSession | undefined> {
    const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
    if (!conversation) return undefined;
    const { conversationId } = conversation;
    return { conversationId, storedCount: await this.conversationStore.getSessionMessageCount(sessionId) };
  }

  /**
   * Reads what the session's transcript holds beyond what is stored, through
   * the adapter for its client, and writes it. Undefined when there is no
   * transcript to read, or when it holds nothing and the session has no
   * conversation yet: an empty transcript earns no conversation row, but an
   * existing conversation is still written to, so a sidecar that appeared
   * since the last write reaches its attribution.
   */
  async captureTranscript(input: TranscriptCaptureInput): Promise<TranscriptCaptureResult | undefined> {
    if (input.sessionId === TIMELINE_SESSION_ID) return undefined;
    const workers = new WorkerStore(this.db);
    if (workers.excluded(input.sessionId, input.attribution?.parentSessionId)) {
      await this.write({ sessionId: input.sessionId, cwd: input.cwd, messages: [], transcriptPath: input.transcriptPath, attribution: input.attribution });
      return undefined;
    }
    const source = transcriptSource(input.client);
    if (source.client === "codex" && this.paths && terminalTranscriptGuard(input.cwd, this.paths, input.sessionId)) return undefined;
    const transcriptPath = source.locate(input);
    if (!transcriptPath) return undefined;
    const discoveredCwd = discoverWorkerDescendant(workers, input.sessionId, transcriptPath);
    if (discoveredCwd !== undefined) {
      await this.conversationStore.withTransaction(() => this.writeInTransaction({
        sessionId: input.sessionId, cwd: input.cwd, messages: [], transcriptPath, attribution: input.attribution,
      }, discoveredCwd));
      return undefined;
    }
    const stored = await this.stored(input.sessionId);
    const delta = await source.read(transcriptPath, stored && this.storedTranscript(source, input.sessionId, stored, transcriptPath), {
      ...input, scrub: (text) => this.scrubber.scrubWithCounts(text).text, redactionKey: this.scrubber.rulesKey,
    }).catch(error => {
      if (error instanceof TranscriptSourceError && error.terminal && source.client === "codex" && this.paths) {
        rememberSubagentGuard(input.cwd, this.paths, transcriptPath, subagentGuardFingerprint(transcriptPath),
          input.sessionId, error.parentSessionId, error.message, { client: "codex", terminal: true });
      }
      throw error;
    });
    if (!stored && delta.messages.length === 0 && delta.checkpoint === undefined && !delta.boundaries?.length) {
      if (delta.sessionUrlDeclarations?.length) await this.conversationStore.withTransaction(() => {
        if (!workers.excluded(input.sessionId)) recordSessionWebUrls(this.db, input.sessionId, delta.sessionUrlDeclarations ?? []);
      });
      return undefined;
    }
    input.signal?.throwIfAborted();
    const written = await this.write({
      sessionId: input.sessionId,
      cwd: input.cwd,
      messages: delta.messages,
      sessionUrlDeclarations: delta.sessionUrlDeclarations,
      parserShape: source.client === "claude" ? CLAUDE_PARSER_SHAPE : null,
      restampParserShape: delta.restampParserShape,
      sourceOffset: delta.sourceOffset,
      boundaries: delta.boundaries,
      transcriptPath,
      attribution: input.attribution,
      ...(delta.checkpoint !== undefined
        ? {
            checkpoint: delta.checkpoint,
            persistCheckpoint: (db, conversationId) =>
              source.saveCheckpoint?.(db, conversationId, transcriptPath, delta.checkpoint),
          }
        : {}),
    });
    const databases = this.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
    const dbPath = databases.find(row => row.name === "main")!.file;
    return { ...written, transcriptPath, ...(delta.verification ? { verification: {
      ...delta.verification, verified: delta.verification.verified && written.conversationId > 0,
    } } : {}), backfillModels: (events) => {
      if (!source.backfillModels || delta.checkpoint === undefined) return delta.backfillModels(events, input.sessionId);
      // /ingest replies and releases its connection before running this callback.
      const db = dbPath ? openStandaloneLcmConnection(dbPath, { readOnly: true }) : this.db;
      try {
        source.backfillModels(db, written.conversationId, events, input.sessionId);
      } finally {
        if (dbPath) db.close();
      }
    } };
  }

  private storedTranscript(source: TranscriptSource, sessionId: string, stored: StoredSession, transcriptPath: string): StoredTranscript {
    return {
      storedCount: stored.storedCount,
      storedMessages: (offset = 0) => this.conversationStore.getSessionMessages(sessionId, offset),
      prefixFingerprint: (count) => this.conversationStore.getSessionPrefixFingerprint(sessionId, count),
      checkpoint: source.loadCheckpoint?.(this.db, stored.conversationId, transcriptPath),
      parserShapeMatches: () => this.conversationStore.sessionHasParserShape(sessionId, CLAUDE_PARSER_SHAPE),
      verifyAfterCompaction: () => this.conversationStore.sessionComparableAfterCompaction(sessionId),
    };
  }

  /**
   * Creates the conversation if needed and writes the messages past the
   * stored count, all in one transaction — a failed write or a crash mid-way
   * leaves neither the conversation row nor a partial message set behind. An
   * empty delta still creates the conversation and still persists a checkpoint.
   *
   * The stored count spans every conversation of the session. Each clear in
   * the new messages opens the conversation that holds the messages after it,
   * even when none follow, unless a conversation already carries that clear.
   * A clear inside stored history is never split out after the fact. The
   * result and the checkpoint belong to the last conversation written.
   */
  async write(input: CaptureInput): Promise<CaptureResult> {
    if (input.sessionId === TIMELINE_SESSION_ID) return { conversationId: 0, records: [], totalCounts: { gitleaks: 0, builtIn: 0, global: 0, project: 0 } };
    const discoveredCwd = discoverWorkerDescendant(new WorkerStore(this.db), input.sessionId, input.transcriptPath);
    return this.conversationStore.withTransaction(() => this.writeInTransaction(input, discoveredCwd));
  }

  /**
   * Replaces a Claude Code session's stored history with its transcript, captured from the
   * start, when the transcript holds everything stored but stored history is not its prefix
   * (src/claude-rebuild.ts). The classification is repeated here, inside the same transaction
   * as the clear and the capture, so what it saw is what is replaced; any failure rolls the
   * whole session back. Aligned, ambiguous and unavailable sessions are left untouched.
   */
  async rebuildTranscript(input: TranscriptCaptureInput): Promise<{ plan: SessionRebuildPlan; ingested: number }> {
    const source = transcriptSource(input.client);
    if (source.client !== "claude") throw new TranscriptSourceError("Only Claude Code sessions can be rebuilt from their transcript");
    const scrub = (text: string) => this.scrubber.scrubWithCounts(text).text;
    const transcriptPath = source.locate(input);
    const delta = transcriptPath ? await source.read(transcriptPath, undefined, { ...input, source: "import", scrub }) : undefined;
    // Parsed before the transaction takes the write lock; the plan reads it only when not aligned.
    const legacy = transcriptPath ? parseTranscript(transcriptPath, "legacy") : undefined;
    const discoveredCwd = discoverWorkerDescendant(new WorkerStore(this.db), input.sessionId, transcriptPath);
    return this.conversationStore.withTransaction(async () => {
      if (new WorkerStore(this.db).excluded(input.sessionId)) return {
        plan: { kind: "unavailable", sessionId: input.sessionId, reason: "Worker session is excluded" } as SessionRebuildPlan, ingested: 0,
      };
      invalidateClaudeTranscriptCursor(this.db, input.sessionId);
      const plan = await planSessionRebuild(this.db, input.sessionId, delta?.messages, scrub, () => legacy);
      if (plan.kind !== "repairable" || plan.conversationId === undefined || !delta) return { plan, ingested: 0 };
      const rebuild: CaptureInput = {
        sessionId: input.sessionId, messages: delta.messages, parserShape: CLAUDE_PARSER_SHAPE,
        sessionUrlDeclarations: delta.sessionUrlDeclarations,
        transcriptPath, attribution: input.attribution,
      };
      // The gate runs before the clear: a session it refuses keeps its stored history.
      if (this.refusedByWorkerGate(rebuild, discoveredCwd)) return {
        plan: { kind: "unavailable", sessionId: input.sessionId, reason: "Worker session is excluded" } as SessionRebuildPlan, ingested: 0,
      };
      clearConversationForRebuild(this.db, plan.conversationId, input.sessionId);
      const written = await this.writeInTransaction(rebuild, discoveredCwd);
      this.conversationStore.setParserShape(plan.conversationId, CLAUDE_PARSER_SHAPE);
      return { plan, ingested: written.records.length };
    });
  }

  /**
   * The worker gate every write passes; true when it refuses the write. A copied claim in the
   * session's own transcript, or disk discovery, installs the permanent exclusion. Supplied
   * ancestry, or a claim read from a transcript named for another session, only refuses.
   */
  private refusedByWorkerGate(input: CaptureInput, discoveredCwd?: string): boolean {
    const attribution = input.attribution
      ?? (input.transcriptPath ? attributionFromTranscriptPath(input.transcriptPath) : undefined);
    const workers = new WorkerStore(this.db);
    const pathSegments = input.transcriptPath?.split(sep) ?? [];
    const rootIndex = pathSegments.indexOf("subagents");
    const directoryParent = rootIndex > 0 ? pathSegments[rootIndex - 1] : undefined;
    const ancestryExcluded = workers.excluded(input.sessionId, attribution?.parentSessionId) ||
      Boolean(directoryParent && workers.excluded(directoryParent));
    const ownTranscript = !input.transcriptPath || transcriptNamesSession(input.transcriptPath, input.sessionId);
    const copiedClaim = !ancestryExcluded && workers.detectCopiedClaim(input.sessionId, input.messages, ownTranscript);
    const discovered = discoveredCwd !== undefined || discoveredWorkerDescendant(workers, input.sessionId);
    if (!ancestryExcluded && !copiedClaim && !discovered) return false;
    if ((copiedClaim && ownTranscript) || discovered) {
      if (this.paths) {
        const events = new EventsDb(eventsDbPathForProject(this.projectId, this.paths));
        try { events.excludeSessions([input.sessionId], discovered); } finally { events.close(); }
      }
      workers.exclude(input.sessionId, discoveredCwd ?? workers.get(input.sessionId)?.cwd ?? input.cwd ?? "", "claude", discovered, copiedClaim && ownTranscript);
    }
    return true;
  }

  private async writeInTransaction(input: CaptureInput, discoveredCwd?: string): Promise<CaptureResult> {
    if (this.refusedByWorkerGate(input, discoveredCwd)) {
      return { conversationId: 0, records: [], totalCounts: { gitleaks: 0, builtIn: 0, global: 0, project: 0 } };
    }
    recordSessionWebUrls(this.db, input.sessionId, input.sessionUrlDeclarations ?? []);
    const attribution = input.attribution
      ?? (input.transcriptPath ? attributionFromTranscriptPath(input.transcriptPath) : undefined);
    // Only a caller that knows the provenance stamps it; an unknown one is verified on its next Claude capture.
    const parserShape = input.parserShape ?? null;
    const conversation = await this.conversationStore.getOrCreateConversation(input.sessionId, undefined, attribution, parserShape);
    const storedCount = await this.conversationStore.getSessionMessageCount(input.sessionId);
    // A resumed read may skip only an already-stored prefix; new content begins at the stored count.
    let start = Math.max(0, storedCount - (input.sourceOffset ?? 0));
    let conversationId = conversation.conversationId;
    const records: MessageRecord[] = [];
    const totalCounts: RedactionCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
    for (const { entryId, at } of input.boundaries ?? []) {
      if (at < start) continue;
      records.push(...await this.append(input.sessionId, conversationId, input.messages.slice(start, at), totalCounts));
      conversationId = (await this.conversationStore.getOrOpenConversationAt(input.sessionId, entryId, attribution, parserShape)).conversationId;
      start = at;
    }
    records.push(...await this.append(input.sessionId, conversationId, input.messages.slice(start), totalCounts));
    if (input.restampParserShape) this.conversationStore.setSessionParserShape(input.sessionId, CLAUDE_PARSER_SHAPE);
    else if (parserShape === STRUCTURED_INGEST_SHAPE) this.conversationStore.setSessionParserShape(input.sessionId, STRUCTURED_INGEST_SHAPE);
    if (records.length > 0) upsertRedactionCounts(this.db, this.projectId, totalCounts);
    if (input.checkpoint !== undefined) input.persistCheckpoint?.(this.db, conversationId);
    return { conversationId, records, totalCounts };
  }

  /** Appends messages after what the conversation already stores, with their context items and parts. */
  private async append(
    sessionId: string, conversationId: number, newMessages: ParsedMessage[], totalCounts: RedactionCounts,
  ): Promise<MessageRecord[]> {
    if (newMessages.length === 0) return [];
    const storedCount = await this.conversationStore.getMessageCount(conversationId);
    const inputs = this.scrub(newMessages, conversationId, storedCount, totalCounts);
    const created = await this.conversationStore.createMessagesBulk(inputs);
    await this.summaryStore.appendContextMessages(conversationId, created.map((r) => r.messageId));
    await this.persistMessageParts(sessionId, newMessages, created);
    return created;
  }

  private scrub(
    newMessages: ParsedMessage[], conversationId: number, storedCount: number, totalCounts: RedactionCounts,
  ): CreateMessageInput[] {
    return newMessages.map((m, i) => {
      const { text, gitleaks, builtIn, global: globalCount, project } = this.scrubber.scrubWithCounts(m.content);
      totalCounts.gitleaks += gitleaks;
      totalCounts.builtIn += builtIn;
      totalCounts.global += globalCount;
      totalCounts.project += project;
      const eventAt = transcriptEventTime(m.eventAt);
      return { conversationId, seq: storedCount + i, role: m.role as MessageRole, content: normalizeMessageContent(text), tokenCount: m.tokenCount, eventAt: eventAt ? new Date(eventAt) : null };
    });
  }

  /**
   * `parseTranscript` is the only place that extracts skill/command structure
   * (see src/transcript.ts) — this just writes what it found, for whichever
   * newly-inserted message carried it.
   */
  private async persistMessageParts(sessionId: string, sourceMessages: ParsedMessage[], created: MessageRecord[]): Promise<void> {
    for (let i = 0; i < created.length; i++) {
      const parts = sourceMessages[i]?.parts;
      if (!parts || parts.length === 0) continue;
      await this.conversationStore.createMessageParts(
        created[i].messageId,
        parts.map((part, ordinal) => toMessagePartInput(sessionId, part, ordinal)),
      );
    }
  }
}
