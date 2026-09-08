import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import { projectDbPath, projectDir, projectId, ensureProjectDir, projectMetaPath, isSafeTranscriptPath, claudeTranscriptPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { upsertRedactionCounts } from "../../db/redaction-stats.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { parseTranscript, type ParsedMessage } from "../../transcript.js";
import { extractCodexSessionMeta, parseCodexTranscript } from "../../codex-transcript.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { enqueue } from "../project-queue.js";
import { readCodexTranscriptDelta, type CodexTranscriptCursor } from "../../codex-transcript-reader.js";
import { loadCodexCursor, saveCodexCursor } from "../../db/codex-cursor.js";

class TranscriptError extends Error {}

function codexTranscriptPath(path: string, cwd: string): string {
  const safePath = isSafeTranscriptPath(path, cwd, "codex");
  if (!safePath) throw new Error("Codex transcript path is not allowed");
  if (!existsSync(safePath)) throw new Error("Codex transcript is unreadable");
  return safePath;
}

function validateCodexMetadata(
  meta: { cwd?: string; id?: string } | undefined, input: IngestInput, cwd: string,
): void {
  if (!meta?.cwd) throw new Error("Codex transcript metadata is missing a cwd");
  if (projectId(meta.cwd) !== projectId(cwd)) throw new Error("Codex transcript cwd does not match requested project");
  if (meta.id ? meta.id !== input.session_id : input.source !== "import") {
    throw new Error("Codex transcript session id does not match request");
  }
}

function isParsedMessage(value: unknown): value is ParsedMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;
  return (
    typeof message.role === "string" &&
    ["user", "assistant", "system", "tool"].includes(message.role) &&
    typeof message.content === "string" &&
    typeof message.tokenCount === "number"
  );
}

export interface IngestInput {
  session_id?: string;
  cwd?: string;
  messages?: unknown;
  transcript_path?: string;
  client?: "claude" | "codex";
  source?: "live" | "import";
  replay?: boolean;
}

export function resolveIngestMessages(input: IngestInput, cwd: string): ParsedMessage[] {
  if (Array.isArray(input.messages)) {
    return input.messages.filter(isParsedMessage);
  }

  // A caller that knows only the session (the function-hooks module) gets Claude Code's
  // own transcript location; it still has to pass isSafeTranscriptPath like any other.
  const transcriptPath = input.transcript_path
    ?? (input.client !== "codex" && input.session_id ? claudeTranscriptPath(cwd, input.session_id) ?? undefined : undefined);

  if (transcriptPath) {
    const client = input.client === "codex" ? "codex" : "claude";
    const safePath = isSafeTranscriptPath(transcriptPath, cwd, client);
    if (client === "codex" && !safePath) {
      throw new Error("Codex transcript path is not allowed");
    }
    if (client === "codex" && (!safePath || !existsSync(safePath))) {
      throw new Error("Codex transcript is unreadable");
    }
    if (safePath && existsSync(safePath)) {
      if (client !== "codex") return parseTranscript(safePath);

      const meta = extractCodexSessionMeta(safePath);
      validateCodexMetadata(meta, input, cwd);
      return parseCodexTranscript(safePath, {
        includeTrailingRecord: input.source === "import",
        strict: true,
      });
    }
  }

  return [];
}

export function createIngestHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}") as IngestInput;
    const { session_id } = input;

    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const dbPath = projectDbPath(cwd);

    let parsed: ParsedMessage[] = [];
    let codexPath: string | undefined;
    try {
      if (input.client === "codex" && input.transcript_path && !Array.isArray(input.messages)) {
        codexPath = codexTranscriptPath(input.transcript_path, cwd);
      } else {
        parsed = resolveIngestMessages(input, cwd);
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid transcript" });
      return;
    }
    if (parsed.length === 0 && !codexPath) {
      sendJson(res, 200, { ingested: 0, totalTokens: 0 });
      return;
    }

    const pid = projectId(cwd);
    try {
      const scrubber = await ScrubEngine.forProject(
        config.security?.sensitivePatterns ?? [],
        projectDir(cwd),
      );
      const result = await enqueue(pid, async () => {
        ensureProjectDir(cwd);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          // Check if session is already fully ingested in session_ingest_log — using the same
          // db connection to avoid double-open overhead and lock contention. Replay and
          // Codex skip this shortcut: Codex imports can recover a final record deferred by
          // live capture, and the stored-count slice below keeps both paths idempotent.
          try {
            const row = input.replay === true || input.client === "codex"
              ? undefined
              : db.prepare("SELECT 1 FROM session_ingest_log WHERE session_id = ?").get(session_id);
            if (row) return { ingested: 0, totalTokens: 0 };
          } catch {
            // Table may not exist yet — proceed with normal flow
          }

          const conversationStore = new ConversationStore(db);
          const summaryStore = new SummaryStore(db);
          const existing = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?")
            .get(session_id) as { conversation_id: number } | undefined;
          const storedCount = existing ? await conversationStore.getMessageCount(existing.conversation_id) : 0;
          let cursor: CodexTranscriptCursor | undefined;
          let sourceCount = 0;
          if (codexPath) {
            let prior = existing ? loadCodexCursor(db, existing.conversation_id, codexPath) : undefined;
            if (prior && prior.messageCount > storedCount) prior = undefined;
            try {
              const delta = await readCodexTranscriptDelta(codexPath, {
                cursor: prior, includeTrailingRecord: input.source === "import",
              });
              validateCodexMetadata(delta.sessionMeta, input, cwd);
              parsed = delta.messages;
              sourceCount = delta.resumed && prior ? prior.messageCount : 0;
              cursor = delta.cursor;
            } catch (error) {
              throw new TranscriptError(error instanceof Error ? error.message : "invalid transcript");
            }
          }
          const conversation = await conversationStore.getOrCreateConversation(session_id);
          // Imports can put the database ahead of a live newline-boundary cursor.
          // Skip that already-stored source prefix without rereading earlier bytes.
          const newMessages = parsed.slice(Math.max(0, storedCount - sourceCount));

          if (newMessages.length === 0 && !cursor) return { ingested: 0, totalTokens: 0 };

          const totalCounts = { gitleaks: 0, builtIn: 0, global: 0, project: 0 };
          const inputs = newMessages.map((m, i) => {
            const { text: scrubbedContent, gitleaks, builtIn, global: globalCount, project } = scrubber.scrubWithCounts(m.content);
            totalCounts.gitleaks += gitleaks;
            totalCounts.builtIn += builtIn;
            totalCounts.global += globalCount;
            totalCounts.project += project;
            return {
              conversationId: conversation.conversationId,
              seq: storedCount + i,
              role: m.role as "user" | "assistant" | "system" | "tool",
              content: scrubbedContent,
              tokenCount: m.tokenCount,
            };
          });
          const records = await conversationStore.withTransaction(async () => {
            const created = inputs.length > 0 ? await conversationStore.createMessagesBulk(inputs) : [];
            if (created.length > 0) {
              upsertRedactionCounts(db, pid, totalCounts);
              await summaryStore.appendContextMessages(conversation.conversationId, created.map((r) => r.messageId));
            }
            if (cursor && codexPath) saveCodexCursor(db, {
              conversationId: conversation.conversationId, transcriptPath: codexPath, cursor,
            });
            return created;
          });
          if (records.length === 0) return { ingested: 0, totalTokens: 0 };

          try {
            const metaPath = projectMetaPath(cwd);
            let meta: Record<string, unknown> = {};
            if (existsSync(metaPath)) {
              meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            }
            meta.cwd = cwd;
            meta.lastIngest = new Date().toISOString();
            writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          } catch {
            // non-fatal: meta.json update failure shouldn't fail the ingest
          }

          const totalTokens = await summaryStore.getContextTokenCount(conversation.conversationId);
          const totalRedacted = totalCounts.gitleaks + totalCounts.builtIn + totalCounts.global + totalCounts.project;
          const redactionCategories: string[] = [];
          if (totalCounts.gitleaks > 0) redactionCategories.push("gitleaks");
          if (totalCounts.builtIn > 0) redactionCategories.push("built_in");
          if (totalCounts.global > 0) redactionCategories.push("global");
          if (totalCounts.project > 0) redactionCategories.push("project");
          return {
            ingested: records.length,
            totalTokens,
            ...(totalRedacted > 0 ? { redacted: totalRedacted, redactedCategories: redactionCategories } : {}),
          };
        } finally {
          closeLcmConnection(dbPath);
        }
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, err instanceof TranscriptError ? 400 : 500, { error: err instanceof Error ? err.message : "ingest failed" });
    }
  };
}
