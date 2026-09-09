import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { readAuthToken } from "../daemon/auth.js";
import { join } from "node:path";
import { request } from "node:http";
import { Buffer } from "node:buffer";
import { lcmPath } from "../lcm-home.js";

/**
 * Build the Authorization header for daemon requests, if a token is available.
 *
 * Auth has been mandatory on the daemon since #109, so every fire-and-forget
 * request must carry an `Authorization: Bearer <token>` header or it fails with
 * HTTP 401 — silently, because a 401 is a normal response, not a socket "error"
 * event. Returns an empty object when no token file exists so callers can spread
 * it unconditionally.
 */
function authHeaders(): Record<string, string> {
  const token = readAuthToken(lcmPath("daemon.token"));
  return token ? { Authorization: "Bearer " + token } : {};
}

/**
 * Fire a compact request to the daemon without blocking the hook process.
 *
 * Uses a raw http.request with socket.unref() so the Node.js event loop
 * does not wait for a response — the process exits as soon as the request
 * is sent. The daemon receives and processes the request independently.
 *
 * This is intentionally separate from DaemonClient.post() (which uses fetch
 * and keeps the event loop alive until a response is received).
 */
export function fireCompactRequest(
  port: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/compact",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  });
  req.on("socket", (socket) => {
    // Defer unref until after the request body is flushed so the /compact
    // request reliably reaches the daemon before the process is allowed to exit.
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {}); // non-fatal
  req.write(json);
  req.end();
}

export function firePromoteRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/promote",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
  req.write(json);
  req.end();
}

export function firePromoteEventsRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/promote-events",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {}); // non-fatal
  req.write(json);
  req.end();
}

export function fireSessionCompleteRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/session-complete",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      ...authHeaders(),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
  req.write(json);
  req.end();
}

/** Deadline for /ingest at SessionEnd — the host kills the hook long before this anyway. */
const INGEST_TIMEOUT_MS = 10_000;

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = lcmPath("daemon.pid");
  // Claude Code gives SessionEnd hooks a shared 1.5s budget: never spawn a daemon here,
  // only talk to one that is already up. The Stop hook has been ingesting incrementally.
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 0,
    noSpawn: true,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const ingestResult = await client.post<{
      ingested: number;
      totalTokens?: number;
      redacted?: number;
      redactedCategories?: string[];
    }>("/ingest", input, { timeoutMs: INGEST_TIMEOUT_MS });

    const configPath = lcmPath("config.json");
    const config = loadDaemonConfig(configPath);
    const disableCompact = config.hooks?.disableAutoCompact ?? false;

    // Notify user when sensitive data was filtered (default: on)
    const notifyOnFilter = config.security?.notify_on_filter !== false;
    if (notifyOnFilter && ingestResult.redacted && ingestResult.redacted > 0) {
      const categories = (ingestResult.redactedCategories ?? []).join(", ");
      process.stderr.write(
        `⚠️  lcm: filtered sensitive data from history (pattern: ${categories})\n`,
      );
    }

    if (!disableCompact) {
      // Fire-and-forget via unreffed http.request — does not block the event loop.
      // The daemon receives and compacts independently after the hook process exits.
      fireCompactRequest(daemonPort, {
        session_id: input.session_id,
        cwd: input.cwd,
        skip_ingest: true,
        client: "claude",
      });
    }

    // Always promote
    firePromoteRequest(daemonPort, { cwd: input.cwd });

    // Promote events for passive learning
    firePromoteEventsRequest(daemonPort, { cwd: input.cwd });

    // Record session completion in manifest.
    // Note: ingestResult.ingested is the delta (new messages this call), not the total.
    // We pass it as-is since we don't have the total without an extra DB query.
    fireSessionCompleteRequest(daemonPort, {
      session_id: input.session_id,
      cwd: input.cwd,
      message_count: ingestResult.ingested ?? 0,
    });

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
