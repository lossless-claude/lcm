import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { ensureAuthToken } from "./auth.js";
import { readHold } from "./hold.js";

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  /** Build fingerprint (BUILD_ID) the daemon must report; a daemon without one is accepted. */
  expectedBuild?: string;
  spawnCommand?: string;
  spawnArgs?: string[];
  /** Connect only if a daemon is already up; never spawn one. */
  noSpawn?: boolean;
  _skipSpawn?: boolean; // for testing — don't attempt to spawn
  _spawnOverride?: typeof spawn;
  _skipHealthWait?: boolean;
  _fetchOverride?: typeof globalThis.fetch;
};

export type EnsureDaemonResult = {
  connected: boolean;
  port: number;
  spawned: boolean;
  /** How the running daemon's version relates to the caller's; absent when no daemon answered. */
  ownership?: DaemonOwnership;
  /** Version the running daemon reported, when one answered. */
  daemonVersion?: string;
};

export type HealthResponse = {
  status: string;
  version?: string;
  build?: string;
  pid?: number;
  uptime?: number;
};

/**
 * One daemon, newest wins.
 * - `restart`: the caller is newer than the daemon (or same version, different build); the caller replaces it.
 * - `older-caller`: the daemon is newer but shares the caller's compatible component; the caller connects and warns once.
 * - `incompatible`: the daemon is newer and its compatible component differs; the caller must not use it.
 * - `current`: nothing to do.
 * The compatible component is the minor while the package is at 0.x and the major from 1.0.
 */
export type DaemonOwnership = "current" | "restart" | "older-caller" | "incompatible";

/** Releases only: a prerelease or build suffix does not parse, so it falls back to string equality. */
function parseSemver(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** True when `a` is a release version strictly older than `b`; false when either does not parse. */
export function isOlderVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  return Boolean(pa && pb) && compareSemver(pa!, pb!) < 0;
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function compatibleComponent(v: [number, number, number]): string {
  return v[0] === 0 ? `0.${v[1]}` : `${v[0]}`;
}

/** True when two release versions share the compatible component (minor while 0.x, major from 1.0). */
export function isCompatibleVersion(a: string | undefined, b: string | undefined): boolean {
  const pa = a ? parseSemver(a) : undefined;
  const pb = b ? parseSemver(b) : undefined;
  return Boolean(pa && pb) && compatibleComponent(pa!) === compatibleComponent(pb!);
}

export function daemonOwnership(health: HealthResponse, expected: { version?: string; build?: string }): DaemonOwnership {
  const mine = expected.version ? parseSemver(expected.version) : undefined;
  const theirs = health.version ? parseSemver(health.version) : undefined;
  if (mine && theirs) {
    const cmp = compareSemver(mine, theirs);
    if (cmp > 0) return "restart";
    if (cmp < 0) return compatibleComponent(mine) === compatibleComponent(theirs) ? "older-caller" : "incompatible";
  } else if (expected.version && health.version && health.version !== expected.version) {
    // Unparseable on one side (a prerelease): a release daemon is never replaced by it.
    return theirs ? "older-caller" : "restart";
  }
  if (expected.build && health.build && health.build !== expected.build) return "restart";
  return "current";
}

/** True when the caller should replace the running daemon with its own build. */
export function isStaleDaemon(health: HealthResponse, expected: { version?: string; build?: string }): boolean {
  return daemonOwnership(health, expected) === "restart";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStalePid(pidFilePath: string): void {
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch { /* ignore */ }
}

/** Register before checking a hold; release only after startup or local database work settles. */
export function registerDaemonActivity(pidFilePath: string): () => void {
  mkdirSync(dirname(pidFilePath), { recursive: true });
  const path = join(dirname(pidFilePath), `daemon.starting.${process.pid}.${randomUUID()}`);
  writeFileSync(path, "", { flag: "wx" });
  return () => { try { unlinkSync(path); } catch { /* already removed by stop */ } };
}

function startingDaemons(pidFilePath: string): { pid: number; path: string }[] {
  const directory = dirname(pidFilePath);
  let names: string[];
  try { names = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((name) => {
    const match = /^daemon\.starting\.(\d+)\.[0-9a-f-]+$/.exec(name);
    const pid = Number(match?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? [{ pid, path: join(directory, name) }] : [];
  });
}

/** PID of the process listening on 127.0.0.1:port, via lsof (macOS/Linux). Undefined when unknown. */
export function findListenerPid(port: number): number | undefined {
  try {
    const out = spawnSync("lsof", ["-nP", "-tiTCP@127.0.0.1:" + port, "-sTCP:LISTEN"], { encoding: "utf-8" });
    const first = String(out.stdout ?? "").trim().split("\n")[0];
    const pid = parseInt(first, 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<HealthResponse | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;

  // Step 0: A hold means someone claimed an offline window. Report not connected
  // without touching the daemon at all — every caller already degrades to a
  // no-op when it cannot connect, which is exactly the behaviour a hold wants.
  if (readHold(opts.pidFilePath)) {
    return { connected: false, port: opts.port, spawned: false };
  }

  // Step 1: Check if daemon is already running via health check
  const health = await checkDaemonHealth(opts.port, fetchFn);
  if (health?.status === "ok") {
    const ownership = daemonOwnership(health, { version: opts.expectedVersion, build: opts.expectedBuild });
    if (ownership === "incompatible") {
      return { connected: false, port: opts.port, spawned: false, ownership, daemonVersion: health.version };
    }
    // Version/build check — if the caller is newer, kill and respawn. A caller that
    // may not spawn (SessionEnd) must not kill either: it uses an older daemon that is
    // still compatible, and leaves the replacement to the next hook that may spawn.
    if (ownership === "restart" && (opts.noSpawn || opts._skipSpawn)) {
      const connected = Boolean(opts.noSpawn) && isCompatibleVersion(health.version, opts.expectedVersion);
      return { connected, port: opts.port, spawned: false, ownership, daemonVersion: health.version };
    }
    if (ownership === "restart") {
      // Prefer the pid the daemon reports about itself; the PID file may have drifted.
      let pid = health.pid;
      if (pid === undefined && existsSync(opts.pidFilePath)) {
        try {
          const parsed = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
          if (!isNaN(parsed)) pid = parsed;
        } catch { /* ignore */ }
      }
      if (pid !== undefined && pid !== process.pid && isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          await sleep(500);
        } catch { /* ignore */ }
      }
      cleanStalePid(opts.pidFilePath);
      // Fall through to spawn
    } else {
      return { connected: true, port: opts.port, spawned: false, ownership, daemonVersion: health.version };
    }
  }

  // A caller that may not spawn wants only a daemon that answers now: no waiting for one
  // that is still starting (Codex caps its short-deadline hooks at three seconds).
  if (opts.noSpawn) {
    return { connected: false, port: opts.port, spawned: false };
  }

  // Step 2: Check PID file for stale process
  if (existsSync(opts.pidFilePath)) {
    try {
      const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(pid) && isProcessAlive(pid)) {
        await sleep(1000);
        const retry = await checkDaemonHealth(opts.port, fetchFn);
        if (retry?.status === "ok") {
          // Same verdict as the first probe: a daemon that was still publishing its PID
          // must not slip past the ownership check. An older one is replaced below.
          const ownership = daemonOwnership(retry, { version: opts.expectedVersion, build: opts.expectedBuild });
          if (ownership !== "restart" || opts.noSpawn || opts._skipSpawn) {
            const connected = ownership !== "incompatible" && ownership !== "restart";
            return { connected, port: opts.port, spawned: false, ownership, daemonVersion: retry.version };
          }
          // Signal the pid the daemon reports about itself, not the one read before the wait.
          const running = retry.pid ?? pid;
          if (running !== process.pid) {
            try { process.kill(running, "SIGTERM"); await sleep(500); } catch { /* fall through to spawn */ }
          }
          cleanStalePid(opts.pidFilePath);
        }
      }
    } catch { /* ignore */ }
    cleanStalePid(opts.pidFilePath);
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn || opts.noSpawn || readHold(opts.pidFilePath)) {
    return { connected: false, port: opts.port, spawned: false };
  }

  // Ensure auth token exists before spawning
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  ensureAuthToken(tokenPath);

  const spawnCommand = opts.spawnCommand ?? process.execPath;
  const sourceLoaderArgs: string[] = [];
  if (!opts.spawnArgs && spawnCommand === process.execPath && /\.(?:[cm]?ts|tsx)$/.test(process.argv[1] ?? "")) {
    // Source entrypoints need the active TS loader, but debugger/eval flags
    // belong to the caller and must not be inherited by a detached daemon.
    for (let i = 0; i < process.execArgv.length; i++) {
      const arg = process.execArgv[i];
      if (/^(?:--import|--loader|--experimental-loader|--require)=/.test(arg)) {
        sourceLoaderArgs.push(arg);
      } else if (["--import", "--loader", "--experimental-loader", "--require", "-r"].includes(arg)
          && process.execArgv[i + 1] !== undefined) {
        sourceLoaderArgs.push(arg, process.execArgv[++i]);
      }
    }
  }
  const spawnArgs = opts.spawnArgs ?? [...sourceLoaderArgs, process.argv[1], "daemon", "start", "--automatic"];
  const spawnImpl = opts._spawnOverride ?? spawn;
  const child = spawnImpl(spawnCommand, spawnArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  }) as ChildProcess;
  child.unref();

  // The child registers itself before checking holds and publishes daemon.pid
  // only after listening. A late parent write could overwrite the winning PID.

  if (opts._skipHealthWait) {
    return { connected: false, port: opts.port, spawned: true };
  }

  // Step 4: Wait for health — only connect if version matches (if expected)
  const deadline = Date.now() + opts.spawnTimeoutMs;
  while (Date.now() < deadline) {
    const h = await checkDaemonHealth(opts.port, fetchFn);
    if (h?.status === "ok") {
      if (isStaleDaemon(h, { version: opts.expectedVersion, build: opts.expectedBuild })) {
        await sleep(300);
        continue;
      }
      return { connected: true, port: opts.port, spawned: true };
    }
    await sleep(300);
  }

  return { connected: false, port: opts.port, spawned: true };
}

/**
 * Stop the daemon recorded in the PID file. Resolves true when the daemon is
 * confirmed down (health no longer answers), false when it is still up after
 * the timeout. A missing or dead PID with no daemon answering counts as stopped.
 */
export async function stopDaemon(opts: {
  port: number;
  pidFilePath: string;
  timeoutMs?: number;
  _fetchOverride?: typeof globalThis.fetch;
}): Promise<{ stopped: boolean; pid?: number }> {
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;
  // Read startup registrations before daemon.pid: a child hands off by writing
  // daemon.pid before removing its registration, so neither state can be missed.
  // A child registering after this snapshot sees the hold published by the caller.
  const starting = startingDaemons(opts.pidFilePath);
  let pid: number | undefined;
  if (existsSync(opts.pidFilePath)) {
    try {
      const parsed = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(parsed)) pid = parsed;
    } catch { /* ignore */ }
  }
  if (pid === undefined || !isProcessAlive(pid)) {
    const health = await checkDaemonHealth(opts.port, fetchFn);
    // Daemons from older builds report no pid; fall back to whoever listens on the port.
    pid = health?.pid ?? (health ? findListenerPid(opts.port) : undefined) ?? pid;
  }
  if (pid !== undefined && isProcessAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* checked below */ }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    // Startup registrations are only waited on, never signalled: a stale
    // registration could refer to a PID the OS has since reused.
    const startingAlive = starting.some((entry) => existsSync(entry.path) && isProcessAlive(entry.pid));
    const alive = (pid !== undefined && isProcessAlive(pid)) || startingAlive;
    const health = await checkDaemonHealth(opts.port, fetchFn);
    // A registered child may have handed off after our initial PID read.
    if (health?.pid !== undefined && health.pid !== pid) {
      pid = health.pid;
      try { process.kill(pid, "SIGTERM"); } catch { /* checked on the next iteration */ }
    }
    if (!alive && !health) {
      cleanStalePid(opts.pidFilePath);
      for (const entry of starting) {
        try { unlinkSync(entry.path); } catch { /* child already removed it */ }
      }
      return { stopped: true, pid };
    }
    await sleep(200);
  }
  return { stopped: false, pid };
}
