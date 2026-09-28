import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { updateProjectMeta } from "../project-meta.js";
import { projectDbPath, projectDir, projectId } from "../project.js";
import { openProject } from "../project-group.js";
import { sendJson } from "../server.js";
import type { BeginBackgroundTask, RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { SubagentAttributionInput } from "../../store/conversation-store.js";
import { TranscriptSourceError, transcriptSource } from "../../transcript-source.js";
import { EventsDb } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import type { SessionClient } from "../../session-client.js";
import { ScrubEngine } from "../../scrub.js";
import { validateCwd } from "../validate-cwd.js";
import { scheduleProjectLanguageDetection } from "../project-language.js";
import { noopDaemonLog, type DaemonLog } from "../log.js";
import { enqueue, withProjectMutation } from "../project-queue.js";
import { backupProjectDatabase } from "../../claude-rebuild.js";
import { applyCutRowRepair, planCutRowRepair, type CutRepairClient } from "../../cut-row-repair.js";
import { SessionCapture, STRUCTURED_INGEST_SHAPE, isSessionComplete, type CaptureInput, type CaptureResult, type TranscriptCaptureResult } from "../../capture.js";
import type { DiscoveredSubagentTranscript } from "../../subagent-attribution.js";

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
  client?: SessionClient;
  source?: "live" | "import";
  replay?: boolean;
  /** Replace a Claude Code session's stored history with its transcript (`lcm import --provider claude --rebuild --yes`). */
  rebuild?: boolean;
  /** With `rebuild`: back the project database up first, and rebuild nothing when that fails. */
  backup?: boolean;
  /** Subagent attribution, carried from the transcript's `.meta.json` sidecar. */
  parent_session_id?: string;
  subagent_type?: string;
  subagent_desc?: string;
  /**
   * Run the tool-call model backfill before replying instead of after, so its failure
   * is reported as `incomplete`. For an in-process caller that waits on the result
   * (the periodic transcript scan), never for a hook the host is timing.
   */
  backfill_before_reply?: boolean;
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
/** A subagent transcript that could not be captured; the parent ingest still succeeds. */
type SubagentFailure = { sessionId: string; err: unknown };

async function ingestAllSubagents(
  db: DatabaseSync, cwd: string, pid: string, scrubber: ScrubEngine, subagents: DiscoveredSubagentTranscript[],
): Promise<SubagentFailure[]> {
  runLcmMigrations(db);
  const capture = new SessionCapture(db, pid, scrubber);
  const failures: SubagentFailure[] = [];
  for (const sub of subagents) {
    try {
      await capture.captureTranscript({
        sessionId: sub.sessionId,
        cwd,
        transcriptPath: sub.path,
        attribution: sub.attribution,
      });
    } catch (err) {
      failures.push({ sessionId: sub.sessionId, err });
    }
  }
  return failures;
}

/**
 * Ingests the subagent transcripts dispatched by one session — the only way
 * they reach the database without `lcm import` run by hand (issue #434). The
 * caller discovers them through the session's transcript adapter; this opens
 * no queue or connection when the list is empty.
 */
async function ingestSubagentTranscripts(
  cwd: string, dbPath: string, pid: string, subagents: DiscoveredSubagentTranscript[], scrubber: ScrubEngine, paths: LcmPaths,
): Promise<SubagentFailure[]> {
  if (subagents.length === 0) return [];

  return enqueue(pid, async () => {
    openProject(cwd, paths);
    return withProjectMutation(pid, async () => {
      const db = getLcmConnection(dbPath);
      try {
        return await ingestAllSubagents(db, cwd, pid, scrubber, subagents);
      } finally {
        closeLcmConnection(dbPath);
      }
    });
  });
}

/**
 * Neither harness's hook payload carries a model (see src/hooks/post-tool.ts),
 * so tool-call events land with `model IS NULL`; the transcript holds it.
 * Best-effort, on every ingest of the session, after the response (before it
 * when the caller sets `backfill_before_reply`): the adapter that read the
 * transcript fills any rows still waiting. Never fails the ingest response;
 * a caller that asked to wait sees its failure as `incomplete`.
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

/**
 * Rebuilds one Claude Code session from its transcript (see `SessionCapture.rebuildTranscript`),
 * inside the project queue and mutation lease like every capture, so a live capture of the same
 * session runs wholly before or after it. The session-complete shortcut does not apply. With
 * `backup`, the project database is copied first; a failed backup fails the request before
 * anything changes. The response names the backup even when the rebuild then fails.
 */
async function rebuildSession(
  input: IngestInput & { session_id: string }, cwd: string, scrubber: ScrubEngine, paths: LcmPaths, res: ServerResponse, log: DaemonLog,
): Promise<void> {
  const dbPath = projectDbPath(cwd, paths);
  const pid = projectId(cwd);
  let backupPath: string | undefined;
  const removedBackups: string[] = [];
  try {
    const result = await enqueue(pid, async () => {
      openProject(cwd, paths);
      return withProjectMutation(pid, async () => {
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          if (input.backup === true) {
            try {
              backupPath = await backupProjectDatabase(db, dbPath, new Date(), (path) => removedBackups.push(path));
            } catch (err) {
              throw new Error(`backup failed, nothing was rebuilt: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          const { plan, ingested } = await new SessionCapture(db, pid, scrubber).rebuildTranscript({
            sessionId: input.session_id, client: input.client, cwd, transcriptPath: input.transcript_path, source: "import",
          });
          return { ingested, rebuild: plan };
        } finally {
          closeLcmConnection(dbPath);
        }
      });
    });
    sendJson(res, 200, { ...result, ...(backupPath ? { backupPath, removedBackups } : {}) });
  } catch (err) {
    const status = err instanceof TranscriptSourceError ? 400 : 500;
    log.write(status === 500 ? "error" : "warn", "ingest.rebuild_failed", { cwd, session_id: input.session_id, err });
    sendJson(res, status, { error: err instanceof Error ? err.message : "rebuild failed", ...(backupPath ? { backupPath, removedBackups } : {}) });
  }
}

async function repairCutSession(
  input: IngestInput & { session_id: string; client: CutRepairClient }, cwd: string,
  scrubber: ScrubEngine, paths: LcmPaths, res: ServerResponse, log: DaemonLog,
): Promise<void> {
  const dbPath = projectDbPath(cwd, paths);
  const pid = projectId(cwd);
  let backupPath: string | undefined;
  const removedBackups: string[] = [];
  try {
    const result = await enqueue(pid, async () => {
      openProject(cwd, paths);
      return withProjectMutation(pid, async () => {
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          const path = transcriptSource(input.client).locate({
            sessionId: input.session_id, cwd, transcriptPath: input.transcript_path, source: "import",
          });
          const plan = await planCutRowRepair(db, {
            sessionId: input.session_id, cwd, client: input.client, transcriptPath: path,
            scrub: (text) => scrubber.scrubWithCounts(text).text,
          });
          if (plan.kind !== "repairable") return { repair: plan, repaired: 0 };
          // One copy per project run, as for a Claude rebuild: the caller asks for it until one exists.
          if (input.backup === true) {
            try {
              backupPath = await backupProjectDatabase(db, dbPath, new Date(), (path) => removedBackups.push(path));
            } catch (error) {
              throw new Error(`backup failed, nothing was repaired: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          return { repair: plan, repaired: applyCutRowRepair(db, plan) };
        } finally {
          closeLcmConnection(dbPath);
        }
      });
    });
    sendJson(res, 200, { ...result, ...(backupPath ? { backupPath, removedBackups } : {}) });
  } catch (error) {
    const status = error instanceof TranscriptSourceError ? 400 : 500;
    log.write(status === 500 ? "error" : "warn", "ingest.cut_repair_failed", { cwd, session_id: input.session_id, err: error });
    sendJson(res, status, { error: error instanceof Error ? error.message : "cut repair failed", ...(backupPath ? { backupPath, removedBackups } : {}) });
  }
}

export function createIngestHandler(
  config: DaemonConfig,
  paths: LcmPaths,
  log: DaemonLog = noopDaemonLog,
  beginBackgroundTask: BeginBackgroundTask = () => () => {},
): RouteHandler {
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
    if (input.rebuild !== true && structured && structured.length === 0) {
      sendJson(res, 200, { ingested: 0, totalTokens: 0 });
      return;
    }

    const source = transcriptSource(input.client);
    if (input.rebuild === true && structured) {
      sendJson(res, 400, { error: "rebuild reads a transcript and takes no messages" });
      return;
    }
    const pid = projectId(cwd);
    try {
      const scrubber = await ScrubEngine.forProject(
        config.security?.sensitivePatterns ?? [],
        projectDir(cwd, paths),
      );
      if (input.rebuild === true) {
        if (source.client === "claude") {
          await rebuildSession({ ...input, session_id }, cwd, scrubber, paths, res, log);
        } else {
          await repairCutSession({ ...input, session_id, client: source.client }, cwd, scrubber, paths, res, log);
        }
        return;
      }
      let captured: TranscriptCaptureResult | undefined;
      const result = await enqueue(pid, async () => {
        openProject(cwd, paths);
        return withProjectMutation(pid, async () => {
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          // A session already fully ingested is skipped — on the same db connection to
          // avoid double-open overhead and lock contention — unless its transcript was
          // written to after completion (a resume appends to the same file). A client
          // whose adapter may recover a deferred tail (and replay) skips this shortcut:
          // the capture module's stored-count slice keeps those paths idempotent.
          if (input.replay !== true && !source.mayRecoverTail) {
            const transcriptPath = structured
              ? undefined
              : source.locate({ sessionId: session_id, cwd, transcriptPath: input.transcript_path, source: input.source });
            if (isSessionComplete(db, session_id, transcriptPath)) return { ingested: 0, totalTokens: 0 };
          }

          const capture = new SessionCapture(db, pid, scrubber);
          const attribution = requestAttribution(input);
          let written: CaptureResult | undefined;
          if (structured) {
            // Structured mode carries the messages themselves and names no transcript.
            written = await capture.write({ sessionId: session_id, messages: structured, parserShape: STRUCTURED_INGEST_SHAPE, attribution });
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
            updateProjectMeta(cwd, paths, { lastIngest: new Date().toISOString() });
          } catch (err) {
            log.write("warn", "ingest.meta_failed", { cwd, session_id, err }); // must not fail the ingest
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
      });
      // Subagent transcripts have no dispatcher of their own — this is the only
      // live path that discovers them (issue #434). Best-effort: a subagent
      // transcript problem must not turn an otherwise-successful ingest into
      // an error response for the session that was actually asked for; it is
      // reported as `incomplete` instead, so a caller can tell work is still pending.
      let incomplete = false;
      const subagents = source.discoverSubagents?.(cwd, session_id) ?? [];
      if (subagents.length > 0) {
        try {
          const failures = await ingestSubagentTranscripts(cwd, dbPath, pid, subagents, scrubber, paths);
          for (const failure of failures) {
            log.write("warn", "ingest.subagent_failed", { cwd, session_id: failure.sessionId, parent_session_id: session_id, err: failure.err });
          }
          if (failures.length > 0) incomplete = true;
        } catch (err) {
          log.write("warn", "ingest.subagents_failed", { cwd, session_id, err });
          incomplete = true;
        }
      }
      const backfill = (read: TranscriptCaptureResult): boolean => {
        try {
          backfillToolModels(cwd, read, paths);
          return true;
        } catch (err) {
          log.write("warn", "ingest.model_backfill_failed", { cwd, session_id, err });
          return false;
        }
      };
      const backfillFirst = input.backfill_before_reply === true;
      if (captured && backfillFirst && !backfill(captured)) incomplete = true;
      sendJson(res, 200, incomplete ? { ...result, incomplete: true } : result);
      // After the response: the scan is O(transcript) and the caller is waiting. Named,
      // since the request has ended by then and a stall during it would otherwise go unattributed.
      if (captured && !backfillFirst) {
        const read = captured;
        const endTask = beginBackgroundTask("ingest:backfill");
        setImmediate(() => {
          try { backfill(read); } finally { endTask(); }
        });
      }
    } catch (err) {
      const status = err instanceof TranscriptSourceError ? 400 : 500;
      log.write(status === 500 ? "error" : "warn", "ingest.failed", { cwd: input.cwd, session_id: input.session_id, err });
      sendJson(res, status, { error: err instanceof Error ? err.message : "ingest failed" });
    }
  };
}
