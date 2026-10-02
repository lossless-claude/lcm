import { CODEX_RECOVERY_RULE_VERSION } from "../transcript-source.js";
import { stalledSubagentGuards } from "./subagent-guard-failures.js";
import { createWorkerSessionHandler } from "./routes/worker-session.js";
import { sweepTimelines } from "./timeline-sweep.js";
import { createTimelineHandler } from "./routes/timeline.js";
import { SummarizeJobStore } from "./summarize-jobs.js";
import { summarizerAvailability } from "./provider-config.js";
import { createNextSummarizeJobHandler, createAnswerSummarizeJobHandler, createPoolSummarizeJobHandler } from "./routes/summarize-jobs.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.js";
import { readProjectMetaIn } from "./project-meta.js";
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
import { createCommitBackfillHandler } from "./routes/commits.js";
import { createPromptSearchHandler } from "./routes/prompt-search.js";
import { createStatusHandler } from "./routes/status.js";
import { createCaptureRetryHandler } from "./routes/capture-retry.js";
import { createSessionCompleteHandler } from "./routes/session-complete.js";
import { createPromoteEventsHandler } from "./routes/promote-events.js";
import { createStatsHandler } from "./routes/stats.js";
import { createPoolStatsHandler } from "./routes/pool-stats.js";
import { createReviewStaleHandler } from "./routes/review-stale.js";
import { createToolEventHandler } from "./routes/tool-event.js";
import { createSessionScavengeHandler } from "./routes/session-scavenge.js";
import { createReplayResetHandler } from "./routes/replay-reset.js";
import { createSessionStartCompactHandler } from "./routes/session-start-compact.js";
import { createSessionEndHandler, invokeRoute, RouteHttpError, type IngestResult } from "./routes/session-end.js";
import { backfillProjectIdentities } from "./project-group.js";
import { yieldToEventLoop } from "./project-queue.js";
import { claudeProjectSlug } from "./project.js";
import { PKG_VERSION, BUILD_ID } from "./version.js";
import { lcmHome } from "../lcm-home.js";
import { createLcmPaths, type LcmPaths } from "../lcm-paths.js";
import { noopDaemonLog, type DaemonLog, type LogLevel } from "./log.js";
import { STALL_THRESHOLD_MS, watchEventLoop, type Stall } from "./stall-monitor.js";
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
  /** Where the daemon records requests, outcomes and failures. Defaults to a log that drops everything. */
  log?: DaemonLog;
  /** How long the event loop may stay blocked before `daemon.stalled` is logged. */
  stallThresholdMs?: number;
};

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

// Routes whose request line is noise at info: per tool call, per poll, per health probe.
const DEBUG_ROUTES = new Set(["POST /tool-event", "GET /health", "GET /summarize-jobs/next"]);

function requestLevel(key: string, status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return DEBUG_ROUTES.has(key) || key.startsWith("POST /summarize-jobs/") ? "debug" : "info";
}

/** A request or daemon-initiated background task in flight; `ended` is set once it finishes. */
export type InFlightRequest = { route: string; started: number; ended?: number; cwd?: string; session_id?: string };

/**
 * Routes that are always in flight by design and never the cause of a stall: a long
 * poll (`GET /summarize-jobs/next` holds up to 25s waiting for a job). Naming one as a
 * cause every time the event loop blocks would bury whatever actually blocked it.
 */
const LONG_POLL_ROUTES = new Set(["GET /summarize-jobs/next"]);

/** Adds a name to `inFlight` for the duration of a background task, so a stall during it is attributed by name like a request would be. Returns the function that marks it ended. */
export function beginBackgroundTask(inFlight: Set<InFlightRequest>, name: string): () => void {
  const record: InFlightRequest = { route: name, started: Date.now() };
  inFlight.add(record);
  return () => { record.ended = Date.now(); };
}

/** What `beginBackgroundTask` looks like once its `inFlight` set is already bound. */
export type BeginBackgroundTask = (name: string) => () => void;

/**
 * One `daemon.stalled` record per non-long-poll request or background task in flight during
 * the block; then forgets requests that ended. Nothing ends while the loop is blocked, so work
 * that ended by the time the block can have begun did not run during it. Work
 * started after the earliest possible end did not run during it either. Long polls
 * are never named as a cause; when nothing else was in flight, one record is written
 * without a route, carrying `longPollCount` if any were pending.
 */
export function reportStall(log: DaemonLog, inFlight: Set<InFlightRequest>, stall: Stall | undefined): void {
  if (stall) {
    const involved = [...inFlight].filter((r) => r.started < stall.endedAfter && (r.ended === undefined || r.ended > stall.begunBy));
    const longPollCount = involved.filter((r) => LONG_POLL_ROUTES.has(r.route)).length;
    const causes = involved.filter((r) => !LONG_POLL_ROUTES.has(r.route));
    for (const r of causes) {
      log.write("warn", "daemon.stalled", { ms: stall.ms, route: r.route, cwd: r.cwd, session_id: r.session_id, started_at: new Date(r.started).toISOString() });
    }
    if (causes.length === 0) log.write("warn", "daemon.stalled", { ms: stall.ms, ...(longPollCount > 0 ? { longPollCount } : {}) });
  }
  for (const r of inFlight) if (r.ended !== undefined) inFlight.delete(r);
}

/** The identity fields of a JSON body, for the request line; never the body itself. */
function requestIdentity(body: string): { cwd?: string; session_id?: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return {};
    const { cwd, session_id } = parsed as Record<string, unknown>;
    return { ...(typeof cwd === "string" ? { cwd } : {}), ...(typeof session_id === "string" ? { session_id } : {}) };
  } catch {
    return {}; // not JSON: the route answers the 400
  }
}

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
  const log = options?.log ?? noopDaemonLog;
  const serverToken = options?.tokenPath ? readAuthToken(options.tokenPath) : null;
  if (options?.tokenPath && serverToken === null) {
    throw new Error(`Auth token file specified but could not be read: ${options.tokenPath}`);
  }
  const routes = new Map<string, RouteHandler>();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTriggered = false;
  const onIdle = options?.onIdle ?? (() => {
    log.close("idle");
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
    sendJson(res, 200, { status: "ok", version: PKG_VERSION, build: BUILD_ID, pid: process.pid, uptime: Math.floor((Date.now() - startTime) / 1000), log: log.state(),
      // Which named endpoints this daemon's environment left out; `lcm doctor` reports it.
      summarizer: summarizerAvailability(config.llm) }));
  const summarizeJobs = new SummarizeJobStore(20_000, 25_000, 60_000, config.llm.poolCompletionMs);
  routes.set("POST /worker-session", createWorkerSessionHandler(paths, summarizeJobs));
  const answerSummarizeJob = createAnswerSummarizeJobHandler(summarizeJobs, paths);
  routes.set("GET /summarize-jobs/next", createNextSummarizeJobHandler(summarizeJobs, paths));
  routes.set("POST /summarize-jobs/pool", createPoolSummarizeJobHandler(summarizeJobs));
  routes.set("POST /compact", createCompactHandler(config, paths, summarizeJobs, log));
  routes.set("POST /replay-reset", createReplayResetHandler(paths));
  const timelineHandler = createTimelineHandler(config, paths, summarizeJobs);
  routes.set("POST /timeline", timelineHandler);
  routes.set("POST /promote", createPromoteHandler(config, paths, log));
  routes.set("POST /restore", createRestoreHandler(config, paths));
  routes.set("POST /grep", createGrepHandler(config, paths));
  routes.set("POST /search", createSearchHandler(config, paths, log));
  routes.set("POST /expand", createExpandHandler(config, paths));
  routes.set("POST /describe", createDescribeHandler(config, paths));
  routes.set("POST /store", createStoreHandler(config, paths));
  routes.set("POST /recent", createRecentHandler(config, paths));
  // Named here (not just for HTTP requests) so a stall during a background task is attributed to it.
  const inFlight = new Set<InFlightRequest>();
  const beginTask: BeginBackgroundTask = (name) => beginBackgroundTask(inFlight, name);
  routes.set("POST /ingest", createIngestHandler(config, paths, log, beginTask));
  routes.set("POST /backfill-commits", createCommitBackfillHandler(config, paths));
  routes.set("POST /prompt-search", createPromptSearchHandler(config, paths));
  routes.set("POST /capture-retry", createCaptureRetryHandler(paths));
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
  const ingestHandler = createIngestHandler(config, paths, log, beginTask);
  const ingestInterval = setInterval(() => {
    const endTask = beginBackgroundTask(inFlight, "scan:transcripts");
    void scanForTranscripts(config, paths, ingestHandler, log).finally(endTask);
  }, INGEST_INTERVAL_MS);
  ingestInterval.unref(); // don't prevent process exit

  let timelineSweep = false;
  const timelineInterval = setInterval(() => {
    if (timelineSweep || !config.timeline.generationEnabled) return;
    timelineSweep = true;
    const endTask = beginBackgroundTask(inFlight, "timeline:tick");
    void sweepTimelines(config, paths, summarizeJobs).catch(() => { /* Next tick resumes durable work. */ })
      .finally(() => { timelineSweep = false; endTask(); });
  }, 30_000);
  timelineInterval.unref();

  // Group every project already on disk, shortly after the daemon is serving so
  // the git calls never delay startup. Refreshes are throttled per project, so
  // only the first run after an upgrade does real work.
  const IDENTITY_BACKFILL_DELAY_MS = 5_000;
  const identityBackfill = options?.backfillIdentities
    ? setTimeout(() => { void backfillProjectIdentities(paths).catch(() => { /* non-fatal */ }); }, IDENTITY_BACKFILL_DELAY_MS)
    : undefined;
  identityBackfill?.unref();

  let stopStallWatch: (() => void) | undefined;

  const server: Server = createServer(async (req, res) => {
    resetIdleTimer();
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const started = Date.now();
    let identity: { cwd?: string; session_id?: string } = {};
    const current: InFlightRequest = { route: key, started };
    inFlight.add(current);
    res.on("close", () => { current.ended = Date.now(); });
    // Registered before the 404 and 401 answers: a stale token on a fire-and-forget request fails only here.
    res.on("finish", () => log.write(requestLevel(key, res.statusCode), "request",
      { route: key, status: res.statusCode, ms: Date.now() - started, ...identity }));
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
      const body = req.method !== "GET" ? await readBody(req) : "";
      identity = requestIdentity(body);
      Object.assign(current, identity);
      // A request that never completes has no `request` record; this one is its trace.
      log.write("debug", "request.start", { route: key, ...identity });
      if (identity.cwd) await log.prepare(identity.cwd);
      await handler(req, res, body);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = status === 413 ? "payload too large" : sanitizeError(err instanceof Error ? err.message : "internal error");
      log.write(status >= 500 ? "error" : "warn", "route.failed", { route: key, ...identity, err });
      sendJson(res, status, { error: message });
    }
  });

  // Start proxy manager if provided (non-fatal on failure)
  if (proxyManager) {
    try {
      await proxyManager.start();
    } catch (err) {
      log.write("warn", "proxy.start_failed", { err });
    }
  }

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      clearInterval(ingestInterval);
      clearInterval(timelineInterval);
      stopStallWatch?.();
      if (identityBackfill) clearTimeout(identityBackfill);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      reject(err);
    });
    server.listen(config.daemon.port, "127.0.0.1", () => {
      resetIdleTimer();
      stopStallWatch = watchEventLoop(options?.stallThresholdMs ?? STALL_THRESHOLD_MS, (stall) => reportStall(log, inFlight, stall));
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;

      // Now that we know the actual port, register the status handler
      routes.set("POST /status", createStatusHandler(config, paths, startTime, actualPort));
      // Needs its own port to reuse fireCompactRequest's loopback call.
      routes.set("POST /session-start-compact", createSessionStartCompactHandler(config, actualPort, paths, log));
      // The follow-ups call this daemon back, so they must present the token it checks.
      const sequencePaths = options?.tokenPath ? { ...paths, tokenPath: options.tokenPath } : paths;
      routes.set("POST /session-end", createSessionEndHandler(config, actualPort, sequencePaths, ingestHandler, log,
        beginTask));

      resolve({
        address: () => addr,
        stop: async () => {
          summarizeJobs.close();
          clearInterval(ingestInterval);
      clearInterval(timelineInterval);
          stopStallWatch?.();
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

// A store with tens of thousands of projects walks that many directories per pass;
// yielding this often keeps any one stretch of synchronous work (each project's
// `meta.json` read) short enough that the event loop never visibly blocks.
const SCAN_YIELD_EVERY = 50;

/** One file's identity for change detection: not its content, just enough to notice it moved. */
type FileFingerprint = { name: string; size: number; mtimeMs: number };

// Every file `/ingest` reads under `subagents/`: each transcript and its `.meta.json`
// attribution sidecar, which can appear after the transcript was first captured and is
// then backfilled by the next ingest. Only `journal.jsonl`, a workflow run's own log that
// no ingest reads, is left out (`discoverSubagentTranscripts` in src/subagent-attribution.ts).
function isSubagentIngestInput(entry: Dirent): boolean {
  return entry.isFile() && entry.name !== "journal.jsonl";
}

/** `undefined` when `path` vanished between its directory's listing and this stat; not fingerprinted, so the next pass tries again. */
async function statFingerprint(path: string): Promise<FileFingerprint | undefined> {
  try {
    const st = await stat(path);
    return { name: path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Every subagent transcript and sidecar under a session's `subagents/` directory
 * (recursively — a workflow run nests its own subagents further, as
 * `discoverSubagentTranscripts` in `src/subagent-attribution.ts` does for the real
 * ingest), stat'd for its fingerprint. Mirrors that module's symlink refusal, but only
 * to notice change, not to attribute or capture anything.
 */
async function subagentFingerprints(dir: string): Promise<FileFingerprint[]> {
  const out: FileFingerprint[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // no subagents directory, or unreadable
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await subagentFingerprints(full));
      continue;
    }
    if (!isSubagentIngestInput(entry)) continue;
    const fingerprint = await statFingerprint(full);
    if (fingerprint) out.push(fingerprint);
  }
  return out;
}

/**
 * A cheap signature for "might this session's stored content be stale": the parent
 * transcript's `(size, mtimeMs)`, plus the same for every subagent transcript and
 * `.meta.json` sidecar under `<sessionDir>/subagents/`. The parent alone is not enough — a
 * subagent transcript is discovered and grows, and its attribution is filled in once its
 * sidecar appears, through the parent's own `/ingest` (`ingestSubagentTranscripts` in
 * `src/daemon/routes/ingest.ts`) while the parent file itself may go untouched.
 * `undefined` when the parent file could not be stat'd (vanished mid-walk): the caller
 * then always attempts the ingest, which fails the same way and is retried next pass.
 */
async function transcriptFingerprint(transcriptPath: string, sessionDir: string): Promise<string | undefined> {
  let parent: FileFingerprint;
  try {
    const st = await stat(transcriptPath);
    parent = { name: transcriptPath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
  const subagentsDir = join(sessionDir, "subagents");
  let subagentsDirIsReal = false;
  try { subagentsDirIsReal = (await lstat(subagentsDir)).isDirectory(); } catch { /* no subagents directory */ }
  const subagents = subagentsDirIsReal
    ? (await subagentFingerprints(subagentsDir)).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return JSON.stringify({ parent, subagents });
}

/** The fingerprint recorded after each transcript path's last successful ingest. */
const transcriptFingerprints = new Map<string, string>();
/** Failed Claude 400 responses need no second parse until the transcript tree changes. */
const failed400Fingerprints = new Map<string, string>();

/**
 * A project-local sidecar of the fingerprints recorded after successful ingests, so a restart
 * does not re-parse unchanged transcripts, without opening every project database. It is tied
 * to the database file's identity: a database replaced (restored, deleted, recreated) makes the
 * sidecar stale, and a stale or unreadable sidecar is ignored, so the scan re-ingests. It is tied
 * to the package version too: an upgrade re-ingests every transcript once, which is how what a
 * new version adds on ingest (backfills, attribution, parser-shape verification) reaches them.
 */
async function databaseIdentity(projectPath: string): Promise<string | undefined> {
  try {
    const info = await stat(join(projectPath, "db.sqlite"));
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

async function readScanFingerprints(projectPath: string): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(projectPath, "scan-fingerprints.json"), "utf8")) as { db?: unknown; version?: unknown; fingerprints?: unknown };
    const db = await databaseIdentity(projectPath);
    if (db === undefined || parsed.db !== db || parsed.version !== (PKG_VERSION ?? null)) return new Map();
    if (!parsed.fingerprints || typeof parsed.fingerprints !== "object") return new Map();
    return new Map(Object.entries(parsed.fingerprints).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return new Map(); // missing or corrupt: re-ingest rather than skip on untrusted state
  }
}

async function writeScanFingerprints(projectPath: string, fingerprints: Map<string, string>): Promise<void> {
  const db = await databaseIdentity(projectPath);
  if (db === undefined) return;
  const path = join(projectPath, "scan-fingerprints.json");
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ db, version: PKG_VERSION ?? null, fingerprints: Object.fromEntries(fingerprints) }), "utf8");
  await rename(tmpPath, path);
}

/** True while a pass of `scanForTranscripts` is running. */
let scanInProgress = false;

/**
 * One pass of the periodic transcript scan: for every project with stored
 * memory, ingests the Claude Code transcripts under
 * `~/.claude/projects/<claudeProjectSlug(cwd)>` that live capture has not
 * reached yet. Best-effort by construction — one rejected transcript, or the
 * sweep itself, must never fault the daemon. A pass still running when the
 * next one is asked for is left alone; the new call is a no-op, so a slow
 * pass and the next scheduled tick never run concurrently.
 *
 * Directory listings are read with `fs/promises`, an async syscall, instead of
 * blocking the event loop; a directory that cannot hold transcripts (no
 * `meta.json` cwd, or no matching Claude project directory) is skipped on that
 * one failed read rather than probed first. The per-project `meta.json` read
 * stays synchronous (one small file), so the outer walk also yields to the
 * event loop every `SCAN_YIELD_EVERY` projects, as `backfillProjectIdentities` does.
 * The inner walk yields between transcripts in the same project.
 * A vanished cwd skips capture without settling any fingerprint. Skipped candidates
 * are counted in one debug entry per pass and retried when the cwd returns.
 *
 * Each session's transcript is skipped when its fingerprint (see
 * `transcriptFingerprint`) matches the one recorded for it, computed before the
 * ingest and recorded only once the ingest resolves without `incomplete`. An unchanged
 * subagent `TranscriptSourceError` is skipped on the next pass, allowing that parent
 * fingerprint to settle; other subagent failures and failed tool-call model backfills
 * (which this call asks `/ingest` to run before replying) keep the parent retryable.
 * A Claude 400 response records a separate fingerprint and is retried once the transcript
 * tree changes; unrelated failures remain retryable next pass. This never marks
 * a session complete; that stays `/session-complete`'s job alone. A completed
 * session whose transcript grew since (a Claude `--resume`) is read again by `/ingest`.
 */
export async function scanForTranscripts(config: DaemonConfig, paths: LcmPaths, ingest: RouteHandler, log: DaemonLog = noopDaemonLog): Promise<void> {
  if (scanInProgress) return;
  scanInProgress = true;
  const seenTranscriptPaths = new Set<string>();
  let missingCwdSessions = 0;
  try {
    const projectsDir = paths.projectsDir;
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      throw err;
    });

    let seen = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (++seen % SCAN_YIELD_EVERY === 0) await yieldToEventLoop();

      const projectPath = join(projectsDir, entry.name);
      const meta = readProjectMetaIn(projectPath);
      if (!meta?.cwd) continue;
      const codexRetries = stalledSubagentGuards(meta.cwd, paths).filter(({ failure }) =>
        failure.client === "codex" && failure.terminal && failure.recoveryRuleVersion !== CODEX_RECOVERY_RULE_VERSION);
      const sessionsDir = join(homedir(), ".claude", "projects", claudeProjectSlug(meta.cwd));
      try {
        await stat(meta.cwd);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const files = await readdir(sessionsDir).catch(() => [] as string[]);
          missingCwdSessions += files.filter(file => file.endsWith(".jsonl")).length + codexRetries.length;
          continue;
        }
      }

      // Retained Codex guard paths need no Claude transcript directory to retry a new rule.
      for (const { path, failure } of codexRetries) {
        try {
          await invokeRoute<IngestResult>(ingest, {
            client: "codex", session_id: failure.sessionId, cwd: meta.cwd, transcript_path: path,
          });
        } catch { /* one rejected recovery must not end the sweep */ }
        await yieldToEventLoop();
      }

      // Find Claude Code session files for this project's cwd
      const files = await readdir(sessionsDir).catch(() => [] as string[]);
      if (!files.some((file) => file.endsWith(".jsonl"))) continue;
      const seenProjectPaths = new Set<string>();

      const persistedFingerprints = await readScanFingerprints(projectPath);
      let persistedChanged = false;
      for (const [path, fingerprint] of persistedFingerprints) {
        if (!transcriptFingerprints.has(path)) transcriptFingerprints.set(path, fingerprint);
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        if (seenProjectPaths.size > 0) await yieldToEventLoop();
        const sessionId = file.slice(0, -".jsonl".length);
        const transcriptPath = join(sessionsDir, file);
        seenTranscriptPaths.add(transcriptPath);
        seenProjectPaths.add(transcriptPath);

        const fingerprint = await transcriptFingerprint(transcriptPath, join(sessionsDir, sessionId));
        if (fingerprint !== undefined &&
            (transcriptFingerprints.get(transcriptPath) === fingerprint || failed400Fingerprints.get(transcriptPath) === fingerprint)) continue;
        failed400Fingerprints.delete(transcriptPath);

        try {
          const result = await invokeRoute<IngestResult>(ingest, {
            session_id: sessionId, cwd: meta.cwd, transcript_path: transcriptPath, backfill_before_reply: true,
          });
          failed400Fingerprints.delete(transcriptPath);
          if (fingerprint !== undefined && !result.incomplete) {
            transcriptFingerprints.set(transcriptPath, fingerprint);
            if (persistedFingerprints.get(transcriptPath) !== fingerprint) {
              persistedFingerprints.set(transcriptPath, fingerprint);
              persistedChanged = true;
            }
          }
        } catch (error) {
          if (fingerprint !== undefined && error instanceof RouteHttpError && error.status === 400) {
            failed400Fingerprints.set(transcriptPath, fingerprint);
          }
          continue; // one rejected transcript must not end the sweep
        }
      }
      for (const path of persistedFingerprints.keys()) {
        if (!seenProjectPaths.has(path)) {
          persistedFingerprints.delete(path);
          persistedChanged = true;
        }
      }
      // Once per project: a crash mid-project only costs re-ingesting it, which is idempotent.
      if (persistedChanged) await writeScanFingerprints(projectPath, persistedFingerprints).catch(() => {});
    }

    for (const path of transcriptFingerprints.keys()) {
      if (!seenTranscriptPaths.has(path)) transcriptFingerprints.delete(path);
    }
    for (const path of failed400Fingerprints.keys()) {
      if (!seenTranscriptPaths.has(path)) failed400Fingerprints.delete(path);
    }
  } catch {
    // non-fatal: periodic scan failure shouldn't crash daemon
  } finally {
    scanInProgress = false;
    if (missingCwdSessions > 0) log.write("debug", "scan.missing_cwd", { sessions: missingCwdSessions });
  }
}
