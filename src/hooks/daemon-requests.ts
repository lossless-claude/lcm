// src/hooks/daemon-requests.ts
import { request } from "node:http";
import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import { readAuthToken } from "../daemon/auth.js";
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
  req.on("socket", (socket: Socket) => {
    req.on("finish", () => socket.unref());
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
