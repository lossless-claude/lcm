import { SummarizeJobStore } from "./summarize-jobs.js";
import { createNextSummarizeJobHandler, createAnswerSummarizeJobHandler } from "./routes/summarize-jobs.js";
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
import { createStatsHandler } from "./routes/stats.js";
import { createPoolStatsHandler } from "./routes/pool-stats.js";
import { createReviewStaleHandler } from "./routes/review-stale.js";
import { createToolEventHandler } from "./routes/tool-event.js";
import { createSessionScavengeHandler } from "./routes/session-scavenge.js";
import { createSessionStartCompactHandler } from "./routes/session-start-compact.js";
import { createSessionEndHandler, invokeRoute } from "./routes/session-end.js";
import { backfillProjectIdentities } from "./project-group.js";
import { PKG_VERSION, BUILD_ID } from "./version.js";
import { lcmHome } from "../lcm-home.js";
import { createLcmPaths, type LcmPaths } from "../lcm-paths.js";
export { PKG_VERSION };

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;
export type DaemonInstance = { address: () => AddressInfo; stop: () => Promise<void>; registerRoute: (method: string, path: string, handler: RouteHandler) => void; idleTriggered: boolean };
export type DaemonOptions = {
  /** Storage locations for this daemon instance. Defaults to the process LCM_HOME. */
  paths?: LcmPaths;
  proxyManager?: ProxyManager;
  onIdle?: () => void;
  tokenPath?: string;
  /**
   * Walk every project on disk and record its git identity, shortly after the
   * daemon starts serving. Only the long-lived daemon wants this: it spawns
   * `git` once per surviving project, which a short-lived instance would pay
   * for and never use.
   */
  backfillIdentities?: boolean;
};

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
  // Sanitize error strings before serializing to prevent stack-trace / path leakage
  const safe =
    data !== null && typeof data === "object" && "error" in data && typeof (data as Record<string, unknown>).error === "string"
      ? { ...(data as Record<string, unknown>), error: sanitizeError((data as Record<string, unknown>).error as string) }
      : data;
  const body = JSON.stringify(safe);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export async function createDaemon(config: DaemonConfig, options?: DaemonOptions): Promise<DaemonInstance> {
  // The storage root, resolved once here — the daemon is a composition root in its own
  // right, since it can be spawned as its own process rather than always through the CLI.
  const paths = options?.paths ?? createLcmPaths(lcmHome());
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
    sendJson(res, 200, { status: "ok", version: PKG_VERSION, build: BUILD_ID, pid: process.pid, uptime: Math.floor((Date.now() - startTime) / 1000) }));
  const summarizeJobs = new SummarizeJobStore();
  const answerSummarizeJob = createAnswerSummarizeJobHandler(summarizeJobs);
  routes.set("GET /summarize-jobs/next", createNextSummarizeJobHandler(summarizeJobs));
  routes.set("POST /compact", createCompactHandler(config, paths, summarizeJobs));
  routes.set("POST /promote", createPromoteHandler(config, paths));
  routes.set("POST /restore", createRestoreHandler(config, paths));
  routes.set("POST /grep", createGrepHandler(config, paths));
  routes.set("POST /search", createSearchHandler(config, paths));
  routes.set("POST /expand", createExpandHandler(config, paths));
  routes.set("POST /describe", createDescribeHandler(config, paths));
  routes.set("POST /store", createStoreHandler(config, paths));
  routes.set("POST /recent", createRecentHandler(config, paths));
  routes.set("POST /ingest", createIngestHandler(config, paths));
  routes.set("POST /prompt-search", createPromptSearchHandler(config, paths));
  routes.set("POST /session-complete", createSessionCompleteHandler(paths));
  routes.set("POST /promote-events", createPromoteEventsHandler(config, paths));
  routes.set("POST /tool-event", createToolEventHandler(config, paths));
  routes.set("POST /session-scavenge", createSessionScavengeHandler(config, paths));
  routes.set("GET /stats", createStatsHandler(paths));
  routes.set("GET /stats/pool", createPoolStatsHandler());
  routes.set("POST /review-stale", createReviewStaleHandler(config, paths));
  // Status handler is registered after listen() when we know the actual port

  // Periodic transcript ingestion scan
  const INGEST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const ingestHandler = createIngestHandler(config, paths);

  const scanForTranscripts = async () => {
    try {
      const { readdirSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const projectsDir = paths.projectsDir;
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

          try {
            await invokeRoute(ingestHandler, { session_id: sessionId, cwd: meta.cwd, transcript_path: transcriptPath });
          } catch {
            continue; // one rejected transcript must not end the sweep
          }
        }
      }
    } catch {
      // non-fatal: periodic scan failure shouldn't crash daemon
    }
  };

  const ingestInterval = setInterval(scanForTranscripts, INGEST_INTERVAL_MS);
  ingestInterval.unref(); // don't prevent process exit

  // Group every project already on disk, shortly after the daemon is serving so
  // the git calls never delay startup. Refreshes are throttled per project, so
  // only the first run after an upgrade does real work.
  const IDENTITY_BACKFILL_DELAY_MS = 5_000;
  const identityBackfill = options?.backfillIdentities
    ? setTimeout(() => { void backfillProjectIdentities(paths).catch(() => { /* non-fatal */ }); }, IDENTITY_BACKFILL_DELAY_MS)
    : undefined;
  identityBackfill?.unref();

  const server: Server = createServer(async (req, res) => {
    resetIdleTimer();
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const handler = routes.get(key) ?? (req.method === "POST" && /^\/summarize-jobs\/[^/?]+$/.test(req.url?.split("?")[0] ?? "") ? answerSummarizeJob : undefined);
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

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      clearInterval(ingestInterval);
      if (identityBackfill) clearTimeout(identityBackfill);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      reject(err);
    });
    server.listen(config.daemon.port, "127.0.0.1", () => {
      resetIdleTimer();
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;

      // Now that we know the actual port, register the status handler
      routes.set("POST /status", createStatusHandler(config, paths, startTime, actualPort));
      // Needs its own port to reuse fireCompactRequest's loopback call.
      routes.set("POST /session-start-compact", createSessionStartCompactHandler(config, actualPort, paths));
      // The follow-ups call this daemon back, so they must present the token it checks.
      const sequencePaths = options?.tokenPath ? { ...paths, tokenPath: options.tokenPath } : paths;
      routes.set("POST /session-end", createSessionEndHandler(config, actualPort, sequencePaths, ingestHandler));

      resolve({
        address: () => addr,
        stop: async () => {
          summarizeJobs.close();
          clearInterval(ingestInterval);
          if (identityBackfill) clearTimeout(identityBackfill);
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
