import type { DatabaseSync } from "node:sqlite";
import { sep } from "node:path";
import type { EventsDb } from "./hooks/events-db.js";
import { upsertRedactionCounts } from "./db/redaction-stats.js";
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
import { readSubagentAttribution } from "./subagent-attribution.js";
import type { MessagePart, ParsedMessage } from "./transcript.js";
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
 * the one caller of the transcript-source seam (src/transcript-source.ts):
 * a route names the client and the session, and Capture picks the adapter.
 */

export type RedactionCounts = { gitleaks: number; builtIn: number; global: number; project: number };

export interface StoredSession {
  /** The session's newest conversation: the one a clear opened last, or its only one. */
  conversationId: number;
  /** Messages stored across every conversation of the session. */
  storedCount: number;
}

export interface CaptureInput {
  sessionId: string;
  /** Transcript messages, from the first one or from `sourceOffset` onwards. Whatever is already stored is skipped. */
  messages: ParsedMessage[];
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

export function isSessionComplete(db: DatabaseSync, sessionId: string): boolean {
  return db.prepare("SELECT 1 FROM session_ingest_log WHERE session_id = ?").get(sessionId) !== undefined;
}

export function markSessionComplete(db: DatabaseSync, sessionId: string, messageCount: number): void {
  db.prepare(
    "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count",
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
    const source = transcriptSource(input.client);
    const transcriptPath = source.locate(input);
    if (!transcriptPath) return undefined;
    const stored = await this.stored(input.sessionId);
    const delta = await source.read(transcriptPath, stored && this.storedTranscript(source, input.sessionId, stored, transcriptPath), {
      ...input, scrub: (text) => this.scrubber.scrubWithCounts(text).text,
    });
    if (!stored && delta.messages.length === 0 && delta.checkpoint === undefined && !delta.boundaries?.length) return undefined;
    const written = await this.write({
      sessionId: input.sessionId,
      messages: delta.messages,
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
    return { ...written, transcriptPath, backfillModels: (events) => delta.backfillModels(events, input.sessionId) };
  }

  private storedTranscript(source: TranscriptSource, sessionId: string, stored: StoredSession, transcriptPath: string): StoredTranscript {
    return {
      storedCount: stored.storedCount,
      storedMessages: () => this.conversationStore.getSessionMessages(sessionId),
      checkpoint: source.loadCheckpoint?.(this.db, stored.conversationId, transcriptPath),
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
    return this.conversationStore.withTransaction(() => this.writeInTransaction(input));
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
    const delta = transcriptPath ? await source.read(transcriptPath, undefined, { ...input, scrub }) : undefined;
    return this.conversationStore.withTransaction(async () => {
      const plan = await planSessionRebuild(this.db, input.sessionId, delta?.messages, scrub);
      if (plan.kind !== "repairable" || plan.conversationId === undefined || !delta) return { plan, ingested: 0 };
      clearConversationForRebuild(this.db, plan.conversationId, input.sessionId);
      const written = await this.writeInTransaction({
        sessionId: input.sessionId, messages: delta.messages, transcriptPath, attribution: input.attribution,
      });
      return { plan, ingested: written.records.length };
    });
  }

  private async writeInTransaction(input: CaptureInput): Promise<CaptureResult> {
    const attribution = input.attribution
      ?? (input.transcriptPath ? attributionFromTranscriptPath(input.transcriptPath) : undefined);
    const conversation = await this.conversationStore.getOrCreateConversation(input.sessionId, undefined, attribution);
    const storedCount = await this.conversationStore.getSessionMessageCount(input.sessionId);
    // A resumed read may skip only an already-stored prefix; new content begins at the stored count.
    let start = Math.max(0, storedCount - (input.sourceOffset ?? 0));
    let conversationId = conversation.conversationId;
    const records: MessageRecord[] = [];
    const totalCounts: RedactionCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
    for (const { entryId, at } of input.boundaries ?? []) {
      if (at < start) continue;
      records.push(...await this.append(input.sessionId, conversationId, input.messages.slice(start, at), totalCounts));
      conversationId = (await this.conversationStore.getOrOpenConversationAt(input.sessionId, entryId, attribution)).conversationId;
      start = at;
    }
    records.push(...await this.append(input.sessionId, conversationId, input.messages.slice(start), totalCounts));
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
      return { conversationId, seq: storedCount + i, role: m.role as MessageRole, content: text, tokenCount: m.tokenCount };
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
