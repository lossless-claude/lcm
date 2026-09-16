import type { DatabaseSync } from "node:sqlite";
import { basename, dirname } from "node:path";
import type { CodexTranscriptCursor } from "./codex-transcript-reader.js";
import { loadCodexCursor, saveCodexCursor } from "./db/codex-cursor.js";
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

/**
 * Capture (see CONTEXT.md): the one writer of a session's transcript content.
 * Every route that lands messages in `messages` goes through `SessionCapture`,
 * so what counts as "already stored", how content is scrubbed, and which
 * sibling rows (`context_items`, `message_parts`, redaction counts, the Codex
 * cursor) accompany a message are decided in exactly one place.
 */

export type RedactionCounts = { gitleaks: number; builtIn: number; global: number; project: number };

export interface StoredSession {
  conversationId: number;
  storedCount: number;
}

export interface CaptureInput {
  sessionId: string;
  /** Transcript messages, from the first one or from `sourceOffset` onwards. Whatever is already stored is skipped. */
  messages: ParsedMessage[];
  /** How many leading messages `messages` already omits (a Codex cursor resume). */
  sourceOffset?: number;
  /** Transcript path; when `attribution` is absent and this is a subagent transcript, its sidecar supplies it. */
  transcriptPath?: string;
  attribution?: SubagentAttributionInput;
  /** Persisted in the same transaction as the messages it accounts for. */
  codexCursor?: { transcriptPath: string; cursor: CodexTranscriptCursor };
}

export interface CaptureResult {
  conversationId: number;
  records: MessageRecord[];
  totalCounts: RedactionCounts;
}

/**
 * A subagent transcript lives at `<parent>/subagents/<agent>.jsonl`; the
 * directory names the parent and the sidecar the dispatch. Any other path is
 * not a subagent transcript and carries no attribution.
 */
export function attributionFromTranscriptPath(transcriptPath: string): SubagentAttributionInput | undefined {
  const subagentsDir = dirname(transcriptPath);
  if (basename(subagentsDir) !== "subagents") return undefined;
  return readSubagentAttribution(transcriptPath, basename(dirname(subagentsDir)));
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

  /** The session's conversation and how many of its messages are stored, or undefined before its first write. */
  async stored(sessionId: string): Promise<StoredSession | undefined> {
    const row = this.db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?")
      .get(sessionId) as { conversation_id: number } | undefined;
    if (!row) return undefined;
    return { conversationId: row.conversation_id, storedCount: await this.conversationStore.getMessageCount(row.conversation_id) };
  }

  /** A Codex cursor is only trusted while it accounts for exactly the stored messages. */
  codexCursor(stored: StoredSession, transcriptPath: string): CodexTranscriptCursor | undefined {
    const cursor = loadCodexCursor(this.db, stored.conversationId, transcriptPath);
    return cursor && cursor.messageCount === stored.storedCount ? cursor : undefined;
  }

  /**
   * Creates the conversation if needed, then writes the messages past the
   * stored count in one transaction. An empty delta still creates the
   * conversation and still persists a cursor.
   */
  async write(input: CaptureInput): Promise<CaptureResult> {
    const attribution = input.attribution
      ?? (input.transcriptPath ? attributionFromTranscriptPath(input.transcriptPath) : undefined);
    const conversation = await this.conversationStore.getOrCreateConversation(input.sessionId, undefined, attribution);
    const conversationId = conversation.conversationId;
    const storedCount = await this.conversationStore.getMessageCount(conversationId);
    // A resumed read may skip only an already-stored prefix; new content begins at the stored count.
    const newMessages = input.messages.slice(Math.max(0, storedCount - (input.sourceOffset ?? 0)));
    const { inputs, totalCounts } = this.scrub(newMessages, conversationId, storedCount);
    if (inputs.length === 0 && !input.codexCursor) return { conversationId, records: [], totalCounts };

    const records = await this.conversationStore.withTransaction(async () => {
      const created = inputs.length > 0 ? await this.conversationStore.createMessagesBulk(inputs) : [];
      if (created.length > 0) {
        upsertRedactionCounts(this.db, this.projectId, totalCounts);
        await this.summaryStore.appendContextMessages(conversationId, created.map((r) => r.messageId));
        await this.persistMessageParts(input.sessionId, newMessages, created);
      }
      if (input.codexCursor) saveCodexCursor(this.db, { conversationId, ...input.codexCursor });
      return created;
    });
    return { conversationId, records, totalCounts };
  }

  private scrub(
    newMessages: ParsedMessage[], conversationId: number, storedCount: number,
  ): { inputs: CreateMessageInput[]; totalCounts: RedactionCounts } {
    const totalCounts: RedactionCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
    const inputs = newMessages.map((m, i) => {
      const { text, gitleaks, builtIn, global: globalCount, project } = this.scrubber.scrubWithCounts(m.content);
      totalCounts.gitleaks += gitleaks;
      totalCounts.builtIn += builtIn;
      totalCounts.global += globalCount;
      totalCounts.project += project;
      return { conversationId, seq: storedCount + i, role: m.role as MessageRole, content: text, tokenCount: m.tokenCount };
    });
    return { inputs, totalCounts };
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
