import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath, projectDir, projectId, projectMetaPath, claudeTranscriptPath } from "../project.js";
import { openProject } from "../project-group.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { SubagentAttributionInput } from "../../store/conversation-store.js";
import { TranscriptSourceError } from "../../transcript-source.js";
import { EventsDb } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { scheduleProjectLanguageDetection } from "../project-language.js";
import { enqueue } from "../project-queue.js";
import { SessionCapture, isSessionComplete, type CaptureInput, type CaptureResult, type TranscriptCaptureResult } from "../../capture.js";
import { discoverSubagentTranscripts, type DiscoveredSubagentTranscript } from "../../subagent-attribution.js";

type ParsedMessage = CaptureInput["messages"][number];

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
  db: DatabaseSync, cwd: string, pid: string, scrubber: ScrubEngine, subagents: DiscoveredSubagentTranscript[],
): Promise<void> {
  runLcmMigrations(db);
  const capture = new SessionCapture(db, pid, scrubber);
  for (const sub of subagents) {
    try {
      await capture.captureTranscript({
        sessionId: sub.sessionId,
        cwd,
        transcriptPath: sub.path,
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
      await ingestAllSubagents(db, cwd, pid, scrubber, subagents);
    } finally {
      closeLcmConnection(dbPath);
    }
  });
}

/**
 * Neither harness's hook payload carries a model (see src/hooks/post-tool.ts),
 * so tool-call events land with `model IS NULL`; the transcript holds it.
 * Best-effort, on every ingest of the session, after the response: the
 * adapter that read the transcript fills any rows still waiting. Never
 * blocks or fails the ingest response.
 */
function backfillToolModels(cwd: string, captured: TranscriptCaptureResult, paths: LcmPaths): void {
  // An import-only project has no sidecar: opening one here would create and migrate
  // an empty database on every ingest, for rows that cannot exist.
  const sidecarPath = eventsDbPath(cwd, paths);
  if (!existsSync(sidecarPath)) return;
  const db = new EventsDb(sidecarPath);
  try {
    captured.backfillModels(db);
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
    const structured = Array.isArray(input.messages) ? input.messages.filter(isParsedMessage) : undefined;
    if (structured && structured.length === 0) {
      sendJson(res, 200, { ingested: 0, totalTokens: 0 });
      return;
    }

    const pid = projectId(cwd);
    try {
      const scrubber = await ScrubEngine.forProject(
        config.security?.sensitivePatterns ?? [],
        projectDir(cwd, paths),
      );
      let captured: TranscriptCaptureResult | undefined;
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
          const attribution = requestAttribution(input);
          let written: CaptureResult | undefined;
          if (structured) {
            // Structured mode carries the messages themselves and names no transcript.
            written = await capture.write({ sessionId: session_id, messages: structured, attribution });
          } else {
            captured = await capture.captureTranscript({
              sessionId: session_id, client: input.client, cwd, transcriptPath: input.transcript_path,
              source: input.source, attribution,
            });
            written = captured;
          }
          if (!written || written.records.length === 0) return { ingested: 0, totalTokens: 0 };
          const { conversationId, records, totalCounts } = written;

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
      if (captured) {
        const read = captured;
        setImmediate(() => {
          try {
            backfillToolModels(cwd, read, paths);
          } catch (err) {
            console.error(`ingest: model backfill failed for session ${session_id}: ${err instanceof Error ? err.message : err}`);
          }
        });
      }
    } catch (err) {
      sendJson(res, err instanceof TranscriptSourceError ? 400 : 500, { error: err instanceof Error ? err.message : "ingest failed" });
    }
  };
}
