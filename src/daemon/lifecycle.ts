import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { ensureAuthToken } from "./auth.js";

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  /** Build fingerprint (BUILD_ID) the daemon must report; a daemon without one is accepted. */
  expectedBuild?: string;
  spawnCommand?: string;
  spawnArgs?: string[];
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

export /** PID of the process listening on 127.0.0.1:port, via lsof (macOS/Linux). Undefined when unknown. */
function findListenerPid(port: number): number | undefined {
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

  // Step 1: Check if daemon is already running via health check
  const health = await checkDaemonHealth(opts.port, fetchFn);
  if (health?.status === "ok") {
    // Version/build check — if mismatch, kill and respawn
    if (isStaleDaemon(health, { version: opts.expectedVersion, build: opts.expectedBuild })) {
      if (existsSync(opts.pidFilePath)) {
        try {
          const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
          if (!isNaN(pid) && isProcessAlive(pid)) {
            process.kill(pid, "SIGTERM");
            await sleep(500);
          }
        } catch { /* ignore */ }
        cleanStalePid(opts.pidFilePath);
      }
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
  if (opts._skipSpawn) {
    return { connected: false, port: opts.port, spawned: false };
  }

  // Ensure auth token exists before spawning
  const tokenPath = join(dirname(opts.pidFilePath), "daemon.token");
  ensureAuthToken(tokenPath);

  const spawnCommand = opts.spawnCommand ?? process.execPath;
  const spawnArgs = opts.spawnArgs ?? [process.argv[1], "daemon", "start"];
  const spawnImpl = opts._spawnOverride ?? spawn;
  const child = spawnImpl(spawnCommand, spawnArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  }) as ChildProcess;
  child.unref();

  if (child.pid) {
    writeFileSync(opts.pidFilePath, String(child.pid));
  }

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
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    const alive = pid !== undefined && isProcessAlive(pid);
    const health = alive ? await checkDaemonHealth(opts.port, fetchFn) : null;
    if (!alive && !health) {
      cleanStalePid(opts.pidFilePath);
      return { stopped: true, pid };
    }
    await sleep(200);
  }
  return { stopped: false, pid };
}
