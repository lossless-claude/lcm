import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { ensureAuthToken } from "./auth.js";

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
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

type HealthResponse = {
  status: string;
  version?: string;
  uptime?: number;
};

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

async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
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
    // Version check — if mismatch, kill and respawn
    if (opts.expectedVersion && health.version && health.version !== opts.expectedVersion) {
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
      if (opts.expectedVersion && h.version && h.version !== opts.expectedVersion) {
        await sleep(300);
        continue;
      }
      return { connected: true, port: opts.port, spawned: true };
    }
    await sleep(300);
  }

  return { connected: false, port: opts.port, spawned: true };
}
