import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { readAuthToken } from "../daemon/auth.js";
import { join } from "node:path";
import { request } from "node:http";
import { Buffer } from "node:buffer";
import type { LcmPaths } from "../lcm-paths.js";

/**
 * Build the Authorization header for daemon requests, if a token is available.
 *
 * Auth has been mandatory on the daemon since #109, so every fire-and-forget
 * request must carry an `Authorization: Bearer <token>` header or it fails with
 * HTTP 401 — silently, because a 401 is a normal response, not a socket "error"
 * event. Returns an empty object when no token file exists so callers can spread
 * it unconditionally.
 */
function authHeaders(paths: LcmPaths): Record<string, string> {
  const token = readAuthToken(paths.tokenPath);
  return token ? { Authorization: "Bearer " + token } : {};
}

/**
 * Fire a request to the daemon without waiting for the response.
 *
 * Called from hook processes and from the daemon itself. Uses a raw http.request
 * with socket.unref(), deferred until the body is flushed, so a hook process can
 * exit as soon as the request is on the wire; inside the daemon unref is inert.
 *
 * This is intentionally separate from DaemonClient.post() (which uses fetch and
 * keeps the event loop alive until a response is received).
 */
export function fireDaemonRequest(port: number, path: string, body: Record<string, unknown>, paths: LcmPaths): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(paths),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {}); // non-fatal
  req.write(json);
  req.end();
}

export function fireCompactRequest(port: number, body: Record<string, unknown>, paths: LcmPaths): void {
  fireDaemonRequest(port, "/compact", body, paths);
}

export function firePromoteRequest(port: number, body: Record<string, unknown>, paths: LcmPaths): void {
  fireDaemonRequest(port, "/promote", body, paths);
}

export function firePromoteEventsRequest(port: number, body: Record<string, unknown>, paths: LcmPaths): void {
  fireDaemonRequest(port, "/promote-events", body, paths);
}

export function fireSessionCompleteRequest(port: number, body: Record<string, unknown>, paths: LcmPaths): void {
  fireDaemonRequest(port, "/session-complete", body, paths);
}

/**
 * Trigger the daemon's SessionStart catch-up sweep for uncompacted conversations
 * of the same project. Fired from `restore.ts` after restore returns its context,
 * so it never adds latency to session start; the daemon does the selection,
 * cap and per-conversation `/compact` calls on its own.
 */
export function fireSessionStartCompactRequest(port: number, body: Record<string, unknown>, paths: LcmPaths): void {
  fireDaemonRequest(port, "/session-start-compact", body, paths);
}

/**
 * Deadline for the `202` from `/session-end`. The host gives SessionEnd hooks a
 * shared budget of about 1.5s, so the daemon must acknowledge, not finish.
 */
const SESSION_END_TIMEOUT_MS = 1_000;
/** Floor for the acknowledgement wait after the health probe has eaten into the budget. */
const MIN_ACK_TIMEOUT_MS = 100;

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  paths: LcmPaths,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = paths.pidPath;
  const started = Date.now();
  // Never spawn a daemon here, only talk to one that is already up. The Stop hook's
  // session-snapshot has been ingesting incrementally, and SessionStart sweeps what
  // this misses.
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 0,
    noSpawn: true,
    expectedVersion: PKG_VERSION,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  // One request; the daemon runs ingest → compact → promote → promote-events →
  // session-complete on its own (`src/daemon/routes/session-end.ts`), so a hook
  // killed by the host loses nothing. The health probe above shares the budget.
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(stdin || "{}");
    const remainingMs = Math.max(MIN_ACK_TIMEOUT_MS, SESSION_END_TIMEOUT_MS - (Date.now() - started));
    await client.post("/session-end", input, { timeoutMs: remainingMs });
  } catch (err) {
    // A compatible daemon of an earlier patch has no /session-end: hand it the
    // transcript the old way, fire-and-forget. Anything else must not block exit,
    // but leaves a trace — the terminal is gone by now.
    if ((err as { status?: number }).status === 404) {
      fireDaemonRequest(daemonPort, "/ingest", input, paths);
    } else {
      // Loaded here, not at module top: hook-errors pulls in node:sqlite, whose
      // experimental warning would otherwise reach stderr on every hook start.
      const { safeLogError } = await import("./hook-errors.js");
      safeLogError("session-end", err, { cwd: input.cwd as string | undefined, sessionId: input.session_id as string | undefined, paths });
    }
  }
  return { exitCode: 0, stdout: "" };
}
