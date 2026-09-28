import { sendJson } from "../server.js";
import type { BeginBackgroundTask, RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { SessionClient } from "../../session-client.js";
import { isSessionClient } from "../../session-client.js";
import {
  fireCompactRequest,
  firePromoteEventsRequest,
  firePromoteRequest,
  fireSessionCompleteRequest,
} from "../../hooks/daemon-requests.js";
import { noopDaemonLog, type DaemonLog } from "../log.js";
import { EventsDb } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { withHookWrite } from "../../hooks/write-admission.js";

export interface IngestResult {
  ingested?: number;
  redacted?: number;
  redactedCategories?: string[];
}

/**
 * Invoke a route handler in-process and return its JSON body — the daemon calling
 * one of its own routes without a socket. Rejects on a 4xx/5xx status, as
 * `DaemonClient.post` does over the wire. Shared by the periodic transcript scan
 * and the session-end sequence.
 */
export async function invokeRoute<T>(handler: RouteHandler, body: Record<string, unknown>): Promise<T> {
  let status = 0;
  let raw = "";
  const res = {
    writeHead: (code: number) => { status = code; },
    end: (data: string) => { raw = data; },
  } as unknown as Parameters<RouteHandler>[1];
  await handler({} as Parameters<RouteHandler>[0], res, JSON.stringify(body));
  if (status >= 400) throw new Error(`HTTP ${status}: ${raw}`);
  return JSON.parse(raw || "{}") as T;
}

/**
 * POST /session-end — everything the SessionEnd command hook used to do itself:
 * ingest the final transcript delta and, once it has landed, fire compact,
 * promote, promote-events and session-complete. Only the ingest is sequenced;
 * the other four depend on it and run as the same fire-and-forget burst the hook
 * used to send.
 *
 * The host gives SessionEnd hooks a budget far shorter than a large ingest, and
 * a hook killed mid-ingest never sends the steps after it. So the hook fires
 * this once and exits; the daemon answers `202` before doing any of the work.
 * Body: `{ session_id, cwd, transcript_path? }`. The ingest outcome and the
 * redaction notice go through `safeLogError`, and the daemon log records the
 * ingest, a suppressed compact and any follow-up that could not be sent; each
 * follow-up route logs its own outcome.
 * `hooks.disableAutoCompact` and `security.notify_on_filter` come from the
 * daemon's startup config.
 */
interface SessionEndRequest {
  input: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  client: SessionClient;
}

/** Parses and validates the body; answers the 400 itself and returns null when it does. */
function parseSessionEndRequest(body: string, res: Parameters<RouteHandler>[1]): SessionEndRequest | null {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return null;
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!sessionId) {
    sendJson(res, 400, { error: "session_id required" });
    return null;
  }
  try {
    return { input, sessionId, cwd: validateCwd(input.cwd as string), client: isSessionClient(input.client) ? input.client : "claude" };
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
    return null;
  }
}

interface SequenceTarget {
  config: DaemonConfig;
  daemonPort: number;
  paths: LcmPaths;
  sessionId: string;
  cwd: string;
  client: SessionClient;
  log: DaemonLog;
}

function recordSessionEndCapture(target: SequenceTarget, status: "completed" | "failed"): void {
  const { cwd, sessionId, client, paths, log } = target;
  const harness = client === "codex" ? "codex" : client === "omp" ? "omp" : "claude-command";
  try {
    withHookWrite(paths, () => {
      const db = new EventsDb(eventsDbPath(cwd, paths));
      try {
        db.recordHookObservation({ sessionId, harness,
          hook: harness === "omp" ? "session_shutdown" : "SessionEnd",
          operation: "capture", kind: "execution", status,
          ...(status === "failed" ? { failureCode: "ingest-error" } : {}),
        });
      } finally { db.close(); }
    }, undefined);
  } catch (err) {
    log.write("warn", "session_end.observation_failed", { cwd, session_id: sessionId, err });
  }
}

/** What the hook used to fire after its own ingest returned. */
function runPostIngestSequence(target: SequenceTarget, ingested: IngestResult): void {
  const { config, daemonPort, paths, sessionId, cwd, client, log } = target;
  recordSessionEndCapture(target, "completed");
  log.write("info", "session_end.ingested", { cwd, session_id: sessionId, ingested: ingested.ingested ?? 0 });
  const onError = (path: string) => (err: Error) =>
    log.write("error", "daemon_request.failed", { path, cwd, session_id: sessionId, err });
  if (config.security?.notify_on_filter !== false && ingested.redacted && ingested.redacted > 0) {
    const categories = (ingested.redactedCategories ?? []).join(", ");
    safeLogError("session-end:redaction-notice", `filtered sensitive data from history (pattern: ${categories})`, { cwd, sessionId, paths });
  }
  if (config.hooks?.disableAutoCompact) {
    log.write("info", "compact.skipped", { cwd, session_id: sessionId, reason: "auto-compact-disabled" });
  } else {
    fireCompactRequest(daemonPort, { session_id: sessionId, cwd, skip_ingest: true, client }, paths, onError("/compact"));
  }
  firePromoteRequest(daemonPort, { cwd }, paths, onError("/promote"));
  firePromoteEventsRequest(daemonPort, { cwd }, paths, onError("/promote-events"));
  // `ingested` is this call's delta, not the session total.
  fireSessionCompleteRequest(daemonPort, { session_id: sessionId, cwd, message_count: ingested.ingested ?? 0 }, paths, onError("/session-complete"));
}

export function createSessionEndHandler(
  config: DaemonConfig,
  daemonPort: number,
  paths: LcmPaths,
  ingest: RouteHandler,
  log: DaemonLog = noopDaemonLog,
  // The hook has already gotten its 202 and gone; this ingest keeps running in-process,
  // so a stall during it needs its own in-flight entry, not the closed request's.
  beginBackgroundTask: BeginBackgroundTask = () => () => {},
): RouteHandler {
  return async (_req, res, body) => {
    const request = parseSessionEndRequest(body, res);
    if (!request) return;
    const { input, sessionId, cwd, client } = request;

    sendJson(res, 202, { accepted: true });

    // Ingest sees the same identity the follow-ups do: trimmed id, real path.
    const ingestBody = { ...input, session_id: sessionId, cwd };
    let captureCompleted = false;
    const endTask = beginBackgroundTask("session-end:ingest");
    void invokeRoute<IngestResult>(ingest, ingestBody)
      .then((ingested) => {
        captureCompleted = true;
        runPostIngestSequence({ config, daemonPort, paths, sessionId, cwd, client, log }, ingested);
      })
      .catch((err: unknown) => {
        if (!captureCompleted) recordSessionEndCapture({ config, daemonPort, paths, sessionId, cwd, client, log }, "failed");
        log.write("error", "session_end.failed", { cwd, session_id: sessionId, err });
        safeLogError("session-end", err, { cwd, sessionId, paths });
      })
      .finally(endTask);
  };
}
