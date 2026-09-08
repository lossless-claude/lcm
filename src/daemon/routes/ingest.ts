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
      if (!meta?.cwd) throw new Error("Codex transcript metadata is missing a cwd");
      if (projectId(meta.cwd) !== projectId(cwd)) {
        throw new Error("Codex transcript cwd does not match requested project");
      }
      if (meta.id ? meta.id !== input.session_id : input.source !== "import") {
        throw new Error("Codex transcript session id does not match request");
      }
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

    let parsed: ParsedMessage[];
    try {
      parsed = resolveIngestMessages(input, cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid transcript" });
      return;
    }
    if (parsed.length === 0) {
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
          const conversation = await conversationStore.getOrCreateConversation(session_id);
          const storedCount = await conversationStore.getMessageCount(conversation.conversationId);
          const newMessages = parsed.slice(storedCount);

          if (newMessages.length === 0) return { ingested: 0, totalTokens: 0 };

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
            const created = await conversationStore.createMessagesBulk(inputs);
            upsertRedactionCounts(db, pid, totalCounts);
            await summaryStore.appendContextMessages(conversation.conversationId, created.map((r) => r.messageId));
            return created;
          });

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
      sendJson(res, 500, { error: err instanceof Error ? err.message : "ingest failed" });
    }
  };
}
