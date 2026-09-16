import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import {
  fireCompactRequest,
  firePromoteEventsRequest,
  firePromoteRequest,
  fireSessionCompleteRequest,
} from "../../hooks/session-end.js";

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
 * Body: `{ session_id, cwd, transcript_path? }`. The daemon runs with stdio
 * ignored, so the ingest outcome and the redaction notice go through
 * `safeLogError`; the four follow-ups are not observed, as in the hook before.
 * `hooks.disableAutoCompact` and `security.notify_on_filter` come from the
 * daemon's startup config.
 */
interface SessionEndRequest {
  input: Record<string, unknown>;
  sessionId: string;
  cwd: string;
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
    return { input, sessionId, cwd: validateCwd(input.cwd as string) };
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
}

/** What the hook used to fire after its own ingest returned. */
function runPostIngestSequence(target: SequenceTarget, ingested: IngestResult): void {
  const { config, daemonPort, paths, sessionId, cwd } = target;
  if (config.security?.notify_on_filter !== false && ingested.redacted && ingested.redacted > 0) {
    const categories = (ingested.redactedCategories ?? []).join(", ");
    safeLogError("session-end:redaction-notice", `filtered sensitive data from history (pattern: ${categories})`, { cwd, sessionId, paths });
  }
  if (!config.hooks?.disableAutoCompact) {
    fireCompactRequest(daemonPort, { session_id: sessionId, cwd, skip_ingest: true, client: "claude" }, paths);
  }
  firePromoteRequest(daemonPort, { cwd }, paths);
  firePromoteEventsRequest(daemonPort, { cwd }, paths);
  // `ingested` is this call's delta, not the session total.
  fireSessionCompleteRequest(daemonPort, { session_id: sessionId, cwd, message_count: ingested.ingested ?? 0 }, paths);
}

export function createSessionEndHandler(config: DaemonConfig, daemonPort: number, paths: LcmPaths, ingest: RouteHandler): RouteHandler {
  return async (_req, res, body) => {
    const request = parseSessionEndRequest(body, res);
    if (!request) return;
    const { input, sessionId, cwd } = request;

    sendJson(res, 202, { accepted: true });

    // Ingest sees the same identity the follow-ups do: trimmed id, real path.
    const ingestBody = { ...input, session_id: sessionId, cwd };
    void invokeRoute<IngestResult>(ingest, ingestBody)
      .then((ingested) => runPostIngestSequence({ config, daemonPort, paths, sessionId, cwd }, ingested))
      .catch((err: unknown) => safeLogError("session-end", err, { cwd, sessionId, paths }));
  };
}
