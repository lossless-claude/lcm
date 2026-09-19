import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath, projectDir, projectId, projectMetaPath, isSafeTranscriptPath, claudeTranscriptPath } from "../project.js";
import { openProject } from "../project-group.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { SubagentAttributionInput } from "../../store/conversation-store.js";
import { parseTranscript, extractToolUseModels, type ParsedMessage } from "../../transcript.js";
import { extractCodexSessionMeta, extractCodexTurnModels, parseCodexTranscript } from "../../codex-transcript.js";
import { EventsDb } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { scheduleProjectLanguageDetection } from "../project-language.js";
import { enqueue } from "../project-queue.js";
import { readCodexTranscriptDelta, type CodexTranscriptCursor } from "../../codex-transcript-reader.js";
import { SessionCapture, isSessionComplete } from "../../capture.js";
import { discoverSubagentTranscripts, type DiscoveredSubagentTranscript } from "../../subagent-attribution.js";

class TranscriptError extends Error {}

function validateCodexRecovery(
  db: DatabaseSync,
  source: { conversationId: number; storedCount: number; messages: ParsedMessage[] },
  scrubber: ScrubEngine,
): void {
  if (source.messages.length < source.storedCount) {
    throw new Error("Codex transcript is shorter than stored history; restore the full transcript before retrying");
  }
  const stored = db.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT ?")
    .all(source.conversationId, source.storedCount) as Array<{ role: string; content: string }>;
  if (stored.length !== source.storedCount) throw new Error("Stored Codex history changed during recovery");
  for (const [index, previous] of stored.entries()) {
    const message = source.messages[index];
    if (message.role !== previous.role || scrubber.scrubWithCounts(message.content).text !== scrubber.scrubWithCounts(previous.content).text) {
      throw new Error("Codex transcript prefix differs from stored history; check the original transcript and redaction settings before retrying");
    }
  }
}

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
  /** Subagent attribution, carried from the transcript's `.meta.json` sidecar. */
  parent_session_id?: string;
  subagent_type?: string;
  subagent_desc?: string;
}

/** Attribution the request carries, or none — so the capture module may read the sidecar instead. */
function requestAttribution(input: IngestInput): SubagentAttributionInput | undefined {
  if (!input.parent_session_id && !input.subagent_type && !input.subagent_desc) return undefined;
  return { parentSessionId: input.parent_session_id, subagentType: input.subagent_type, subagentDesc: input.subagent_desc };
}

/**
 * A subagent transcript grows while its parent session is still running, so
 * every `/ingest` for the parent captures whatever the subagent transcripts
 * have added since; the capture module never re-inserts what is stored.
 */
async function ingestAllSubagents(
  db: DatabaseSync, pid: string, scrubber: ScrubEngine, subagents: DiscoveredSubagentTranscript[],
): Promise<void> {
  runLcmMigrations(db);
  const capture = new SessionCapture(db, pid, scrubber);
  for (const sub of subagents) {
    try {
      const messages = parseTranscript(sub.path);
      // A transcript the subagent has not written to yet earns no conversation row.
      if (messages.length === 0) continue;
      await capture.write({
        sessionId: sub.sessionId,
        messages,
        attribution: sub.attribution,
      });
    } catch (err) {
      console.error(`ingest: subagent capture failed for session ${sub.sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * The subagent transcripts of one already-known session, at
 * `<project>/<session_id>/subagents/`. Scoped to that one session directory:
 * `/ingest` already knows which session it is processing, so this never
 * walks the whole projects tree.
 */
function discoverSubagentSessionTranscripts(cwd: string, sessionId: string): DiscoveredSubagentTranscript[] {
  const transcriptPath = claudeTranscriptPath(cwd, sessionId);
  if (!transcriptPath) return [];
  return discoverSubagentTranscripts(join(dirname(transcriptPath), sessionId));
}

/**
 * Discovers and ingests the subagent transcripts dispatched by one session —
 * the only way they reach the database without `lcm import` run by hand
 * (issue #434). Skipped entirely, before opening any queue or connection,
 * when the session has no `subagents/` directory.
 */
async function ingestSubagentTranscripts(
  cwd: string, dbPath: string, pid: string, sessionId: string, scrubber: ScrubEngine, paths: LcmPaths,
): Promise<void> {
  const subagents = discoverSubagentSessionTranscripts(cwd, sessionId);
  if (subagents.length === 0) return;

  await enqueue(pid, async () => {
    openProject(cwd, paths);
    const db = getLcmConnection(dbPath);
    try {
      await ingestAllSubagents(db, pid, scrubber, subagents);
    } finally {
      closeLcmConnection(dbPath);
    }
  });
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

function resolveClaudeTranscriptPathForBackfill(input: IngestInput, cwd: string): string | undefined {
  const path = input.transcript_path
    ?? (input.session_id ? claudeTranscriptPath(cwd, input.session_id) ?? undefined : undefined);
  if (!path) return undefined;
  const safe = isSafeTranscriptPath(path, cwd, "claude");
  return safe && existsSync(safe) ? safe : undefined;
}

/**
 * Claude's PostToolUse payload carries no model (see src/hooks/post-tool.ts),
 * so its events land with `model IS NULL`. Best-effort, on every ingest of the
 * session: scan the transcript for each tool_use block's model and fill any
 * rows still waiting. Never blocks or fails the ingest response — a session
 * with nothing to fill costs one indexed lookup.
 */
function backfillClaudeToolModels(cwd: string, sessionId: string, transcriptPath: string | undefined, paths: LcmPaths): void {
  if (!transcriptPath) return;
  // An import-only project has no sidecar: opening one here would create and migrate
  // an empty database on every ingest, for rows that cannot exist.
  const sidecarPath = eventsDbPath(cwd, paths);
  if (!existsSync(sidecarPath)) return;
  const db = new EventsDb(sidecarPath);
  try {
    if (!db.hasUnfilledModels(sessionId)) return;
    db.backfillToolCallModels(sessionId, extractToolUseModels(transcriptPath));
  } finally {
    db.close();
  }
}

function backfillCodexToolModels(cwd: string, sessionId: string, transcriptPath: string | undefined, paths: LcmPaths): void {
  if (!transcriptPath) return;
  const sidecarPath = eventsDbPath(cwd, paths);
  if (!existsSync(sidecarPath)) return;
  const db = new EventsDb(sidecarPath);
  try {
    if (!db.hasUnfilledCodexModels(sessionId)) return;
    db.backfillCodexTurnModels(sessionId, extractCodexTurnModels(transcriptPath));
  } finally {
    db.close();
  }
}

export function createIngestHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
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

    const dbPath = projectDbPath(cwd, paths);

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
        projectDir(cwd, paths),
      );
      const result = await enqueue(pid, async () => {
        openProject(cwd, paths);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          // A session already fully ingested is skipped — on the same db connection to
          // avoid double-open overhead and lock contention. Replay and Codex skip this
          // shortcut: Codex imports can recover a final record deferred by live capture,
          // and the capture module's stored-count slice keeps both paths idempotent.
          if (input.replay !== true && input.client !== "codex" && isSessionComplete(db, session_id)) {
            return { ingested: 0, totalTokens: 0 };
          }

          const capture = new SessionCapture(db, pid, scrubber);
          let cursor: CodexTranscriptCursor | undefined;
          let sourceOffset = 0;
          if (codexPath) {
            const existing = await capture.stored(session_id);
            const prior = existing ? capture.codexCursor(existing, codexPath) : undefined;
            try {
              const delta = await readCodexTranscriptDelta(codexPath, {
                cursor: prior, includeTrailingRecord: input.source === "import",
              });
              validateCodexMetadata(delta.sessionMeta, input, cwd);
              if (!delta.resumed && existing) {
                validateCodexRecovery(db, { ...existing, messages: delta.messages }, scrubber);
              }
              parsed = delta.messages;
              sourceOffset = delta.resumed && prior ? prior.messageCount : 0;
              cursor = delta.cursor;
            } catch (error) {
              throw new TranscriptError(error instanceof Error ? error.message : "invalid transcript");
            }
          }
          const { conversationId, records, totalCounts } = await capture.write({
            sessionId: session_id,
            messages: parsed,
            sourceOffset,
            transcriptPath: input.client === "codex" ? codexPath : resolveClaudeTranscriptPathForBackfill(input, cwd),
            attribution: requestAttribution(input),
            ...(cursor && codexPath ? { codexCursor: { transcriptPath: codexPath, cursor } } : {}),
          });
          if (records.length === 0) return { ingested: 0, totalTokens: 0 };

          try {
            const metaPath = projectMetaPath(cwd, paths);
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
          // Samples the corpus on this connection now; the model call runs after the response.
          void scheduleProjectLanguageDetection(cwd, db, config, paths, input.client);

          const totalTokens = await capture.summaryStore.getContextTokenCount(conversationId);
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
      // Subagent transcripts have no dispatcher of their own — this is the only
      // live path that discovers them (issue #434). Best-effort: a subagent
      // transcript problem must not turn an otherwise-successful ingest into
      // an error response for the session that was actually asked for.
      if (input.client !== "codex") {
        try {
          await ingestSubagentTranscripts(cwd, dbPath, pid, session_id, scrubber, paths);
        } catch (err) {
          console.error(`ingest: subagent discovery failed for session ${session_id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      sendJson(res, 200, result);
      // After the response: the scan is O(transcript) and the caller is waiting.
      if (input.client !== "codex") {
        setImmediate(() => {
          try {
            backfillClaudeToolModels(cwd, session_id, resolveClaudeTranscriptPathForBackfill(input, cwd), paths);
          } catch (err) {
            console.error(`ingest: model backfill failed for session ${session_id}: ${err instanceof Error ? err.message : err}`);
          }
        });
      } else {
        setImmediate(() => {
          try {
            backfillCodexToolModels(cwd, session_id, codexPath, paths);
          } catch (err) {
            console.error(`ingest: Codex model backfill failed for session ${session_id}: ${err instanceof Error ? err.message : err}`);
          }
        });
      }
    } catch (err) {
      sendJson(res, err instanceof TranscriptError ? 400 : 500, { error: err instanceof Error ? err.message : "ingest failed" });
    }
  };
}
