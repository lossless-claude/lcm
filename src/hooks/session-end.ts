import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";
import { Buffer } from "node:buffer";

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
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
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
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
  req.write(json);
  req.end();
}

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 5000,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const ingestResult = await client.post<{
      ingested: number;
      totalTokens?: number;
    }>("/ingest", input);

    const configPath = join(homedir(), ".lossless-claude", "config.json");
    const config = loadDaemonConfig(configPath);
    const disableCompact = config.hooks?.disableAutoCompact ?? false;

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
