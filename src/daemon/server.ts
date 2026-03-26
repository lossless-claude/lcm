import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.js";
import { sanitizeError } from "./safe-error.js";
import { readAuthToken } from "./auth.js";
import type { ProxyManager } from "./proxy-manager.js";
import { createCompactHandler } from "./routes/compact.js";
import { createPromoteHandler } from "./routes/promote.js";
import { createRestoreHandler } from "./routes/restore.js";
import { createGrepHandler } from "./routes/grep.js";
import { createSearchHandler } from "./routes/search.js";
import { createExpandHandler } from "./routes/expand.js";
import { createDescribeHandler } from "./routes/describe.js";
import { createStoreHandler } from "./routes/store.js";
import { createRecentHandler } from "./routes/recent.js";
import { createIngestHandler } from "./routes/ingest.js";
import { createPromptSearchHandler } from "./routes/prompt-search.js";
import { createStatusHandler } from "./routes/status.js";
import { createSessionCompleteHandler } from "./routes/session-complete.js";
import { createPromoteEventsHandler } from "./routes/promote-events.js";
import { PKG_VERSION } from "./version.js";
export { PKG_VERSION };

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;
export type DaemonInstance = { address: () => AddressInfo; stop: () => Promise<void>; registerRoute: (method: string, path: string, handler: RouteHandler) => void; idleTriggered: boolean };
export type DaemonOptions = { proxyManager?: ProxyManager; onIdle?: () => void; tokenPath?: string };

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Drain and discard remaining data so we can write a response
      req.resume();
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export async function createDaemon(config: DaemonConfig, options?: DaemonOptions): Promise<DaemonInstance> {
  const startTime = Date.now();
  const proxyManager = options?.proxyManager;
  const serverToken = options?.tokenPath ? readAuthToken(options.tokenPath) : null;
  if (options?.tokenPath && serverToken === null) {
    throw new Error(`Auth token file specified but could not be read: ${options.tokenPath}`);
  }
  const routes = new Map<string, RouteHandler>();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTriggered = false;
  const onIdle = options?.onIdle ?? (() => {
    console.log("[lcm] idle timeout — shutting down");
    process.exit(0);
  });

  function resetIdleTimer() {
    if (config.daemon.idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTriggered = true;
      onIdle();
    }, config.daemon.idleTimeoutMs);
  }

  routes.set("GET /health", async (_req, res) =>
    sendJson(res, 200, { status: "ok", version: PKG_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000) }));
  routes.set("POST /compact", createCompactHandler(config));
  routes.set("POST /promote", createPromoteHandler(config));
  routes.set("POST /restore", createRestoreHandler(config));
  routes.set("POST /grep", createGrepHandler(config));
  routes.set("POST /search", createSearchHandler());
  routes.set("POST /expand", createExpandHandler(config));
  routes.set("POST /describe", createDescribeHandler(config));
  routes.set("POST /store", createStoreHandler(config));
  routes.set("POST /recent", createRecentHandler(config));
  routes.set("POST /ingest", createIngestHandler(config));
  routes.set("POST /prompt-search", createPromptSearchHandler(config));
  routes.set("POST /session-complete", createSessionCompleteHandler());
  routes.set("POST /promote-events", createPromoteEventsHandler(config));
  // Status handler is registered after listen() when we know the actual port

  // Periodic transcript ingestion scan
  const INGEST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const ingestHandler = createIngestHandler(config);

  const scanForTranscripts = async () => {
    try {
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const projectsDir = join(homedir(), ".lossless-claude", "projects");
      if (!existsSync(projectsDir)) return;

      for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const metaPath = join(projectsDir, entry.name, "meta.json");
        if (!existsSync(metaPath)) continue;

        let meta: { cwd?: string; lastCompact?: string } = {};
        try { meta = JSON.parse(readFileSync(metaPath, "utf-8")); } catch { continue; }
        if (!meta.cwd) continue;

        // Find Claude Code session files for this project's cwd
        const cwdDashed = meta.cwd.replace(/\//g, "-").replace(/^-/, "");
        const sessionsDir = join(homedir(), ".claude", "projects", cwdDashed);
        if (!existsSync(sessionsDir)) continue;

        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const sessionId = file.replace(".jsonl", "");
          const transcriptPath = join(sessionsDir, file);

          // Use the ingest route logic directly
          const mockReq = {} as any;
          const response = { statusCode: 200, body: "" };
          const mockRes = {
            writeHead: (code: number) => { response.statusCode = code; },
            end: (data: string) => { response.body = data; },
          } as any;

          await ingestHandler(mockReq, mockRes, JSON.stringify({
            session_id: sessionId,
            cwd: meta.cwd,
            transcript_path: transcriptPath,
          }));
        }
      }
    } catch {
      // non-fatal: periodic scan failure shouldn't crash daemon
    }
  };

  const ingestInterval = setInterval(scanForTranscripts, INGEST_INTERVAL_MS);
  ingestInterval.unref(); // don't prevent process exit

  const server: Server = createServer(async (req, res) => {
    resetIdleTimer();
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const handler = routes.get(key);
    if (!handler) { sendJson(res, 404, { error: "not found" }); return; }
    // Auth: skip for GET /health, require Bearer token for everything else
    if (serverToken && key !== "GET /health") {
      const rawAuth = req.headers["authorization"];
      const authHeader = (Array.isArray(rawAuth) ? rawAuth[0] : rawAuth) ?? "";
      if (authHeader.trim() !== `Bearer ${serverToken}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }
    try {
      await handler(req, res, req.method !== "GET" ? await readBody(req) : "");
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = status === 413 ? "payload too large" : sanitizeError(err instanceof Error ? err.message : "internal error");
      sendJson(res, status, { error: message });
    }
  });

  // Start proxy manager if provided (non-fatal on failure)
  if (proxyManager) {
    try {
      await proxyManager.start();
    } catch (err) {
      console.warn(`[lcm] claude-server proxy failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  return new Promise((resolve) => {
    server.listen(config.daemon.port, "127.0.0.1", () => {
      resetIdleTimer();
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;

      // Now that we know the actual port, register the status handler
      routes.set("POST /status", createStatusHandler(config, startTime, actualPort));

      resolve({
        address: () => addr,
        stop: async () => {
          clearInterval(ingestInterval);
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          if (proxyManager) {
            try { await proxyManager.stop(); } catch { /* non-fatal */ }
          }
          return new Promise<void>((r) => server.close(() => r()));
        },
        registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
        get idleTriggered() { return idleTriggered; },
      });
    });
  });
}
