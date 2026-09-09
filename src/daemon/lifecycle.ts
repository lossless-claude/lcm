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
};

export type HealthResponse = {
  status: string;
  version?: string;
  build?: string;
  pid?: number;
  uptime?: number;
};

/** True when the daemon reports a version or build that differs from what the caller expects. */
export function isStaleDaemon(health: HealthResponse, expected: { version?: string; build?: string }): boolean {
  if (expected.version && health.version && health.version !== expected.version) return true;
  if (expected.build && health.build && health.build !== expected.build) return true;
  return false;
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

/** Register before the last hold check; keep visible until the listening PID is published. */
export function registerDaemonStartup(pidFilePath: string): () => void {
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
    // Version/build check — if mismatch, kill and respawn
    if (isStaleDaemon(health, { version: opts.expectedVersion, build: opts.expectedBuild })) {
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
      return { connected: true, port: opts.port, spawned: false };
    }
  }

  // Step 2: Check PID file for stale process
  if (existsSync(opts.pidFilePath)) {
    try {
      const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(pid) && isProcessAlive(pid)) {
        await sleep(1000);
        const retry = await checkDaemonHealth(opts.port, fetchFn);
        if (retry?.status === "ok") {
          return { connected: true, port: opts.port, spawned: false };
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
  const spawnArgs = opts.spawnArgs ?? [process.argv[1], "daemon", "start", "--automatic"];
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
