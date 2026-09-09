import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerDaemonActivity } from "../../src/daemon/lifecycle.js";

const execute = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("startup barrier timed out");
    await delay(10);
  }
}

it.each([1, 2])("held stop waits for %i concurrent startup(s) before claiming an offline window", async (count) => {
  const root = mkdtempSync(join(tmpdir(), "lcm-startup-race-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port } }));
  const preload = join(root, "pause-start.mjs");
  // Freeze the real CLI after observing no hold, but before createDaemon.
  // The stale false result is intentional: another read alone cannot fix this race.
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const root = process.env.LCM_HOME;
    const original = fs.existsSync;
    let paused = false;
    fs.existsSync = function(path) {
      const result = original(path);
      if (!paused && String(path) === root + '/daemon.hold'
          && fs.readdirSync(root).some(name => name.startsWith('daemon.starting.' + process.pid + '.'))) {
        paused = true;
        fs.writeFileSync(root + '/ready.' + process.pid, '');
        while (!original(root + '/resume')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, HOME: root, LCM_HOME: root };
  const cli = resolve("dist/bin/lcm.js");
  const starts = Array.from({ length: count }, () => execute(process.execPath,
    ["--import", preload, cli, "daemon", "start", "--automatic"], { env, timeout: 15000 }));
  // Attach rejection handlers immediately: cancellation may precede the assertion.
  const outcomes = starts.map((start) => start.then(() => ({ code: 0, stderr: "", signal: null }),
    (error: { code: number | null; stderr: string; signal: string | null }) => error));
  let stop: ReturnType<typeof execute> | undefined;
  try {
    await waitFor(() => readdirSync(root).filter((name) => name.startsWith("ready.")).length === count);
    stop = execute(process.execPath, [cli, "daemon", "stop", "--hold"], { env, timeout: 10000 });
    let settled = false;
    void stop.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => existsSync(join(root, "daemon.hold")));
    await delay(100);
    expect(settled).toBe(false);
    writeFileSync(join(root, "resume"), "");
    for (const outcome of await Promise.all(outcomes)) {
      // Concurrent starters can lose the listen race, or stop can signal one
      // after it listens. Every path must terminate before stop succeeds.
      if (outcome.code === 1) expect(outcome.stderr).toContain("already in use");
      else if (outcome.signal) expect(outcome.signal).toBe("SIGTERM");
      else expect(outcome.code).toBe(75);
    }
    await expect(stop).resolves.toMatchObject({ stderr: "" });
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    expect(readdirSync(root).filter((name) => name.startsWith("daemon.starting."))).toEqual([]);
  } finally {
    writeFileSync(join(root, "resume"), "");
    for (const start of starts) start.child.kill();
    await Promise.allSettled([...outcomes, ...(stop ? [stop] : [])]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it("held stop fails instead of claiming maintenance readiness when startup never settles", async () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-startup-timeout-"));
  const unregister = registerDaemonActivity(join(root, "daemon.pid"));
  // A registration with a live owner must not be signalled: it could be stale
  // and the OS may have reused that PID for an unrelated process.
  writeFileSync(join(root, "config.json"), JSON.stringify({ daemon: { port: 1 } }));
  try {
    const result = await execute(process.execPath, [resolve("dist/bin/lcm.js"), "daemon", "stop", "--hold"], {
      env: { ...process.env, HOME: root, LCM_HOME: root }, timeout: 10000,
    }).then(() => { throw new Error("stop must not succeed"); }, (error) => error);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("still up");
    expect(result.stdout).not.toContain("held down until");
    expect(existsSync(join(root, "daemon.hold"))).toBe(true);
  } finally {
    unregister();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
