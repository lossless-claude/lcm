/**
 * The suite never reaches the developer's own daemon.
 *
 * That daemon (and the CI runner's, which runs as the same user) listens on the default
 * port. `ensureDaemon` SIGTERMs a daemon there whose version differs from the caller's and
 * spawns its own; `stopDaemon` SIGTERMs whatever answers. `setup-env.ts` gives every test
 * file an lcm home whose config.json names another port and a HOME of its own, and
 * `setup-port-guard.mjs` refuses the default port in every process the suite runs. Nothing
 * here writes a config of its own: that is the point.
 *
 * So this file is only safe while at least one of those layers is in place: without both,
 * its CLI case runs `lcm daemon stop` against the default port for real. To see it fail,
 * remove one layer at a time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ensureCore } from "../src/bootstrap.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { lcmHome } from "../src/lcm-home.js";
import { createLcmPaths } from "../src/lcm-paths.js";

// The spawn ensureDaemon makes is recorded instead of run: in-process it would start
// vitest's own worker entry as a "daemon". Every other spawn is real.
const daemonSpawns = vi.hoisted(() => [] as { args: string[]; env?: NodeJS.ProcessEnv }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const guarded = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    if (Array.isArray(args) && args.includes("--automatic")) {
      daemonSpawns.push({ args, env: options?.env });
      return { pid: undefined, unref() {}, on() { return this; } };
    }
    return (actual.spawn as (...a: unknown[]) => unknown)(command, args, options);
  }) as typeof actual.spawn;
  return { ...actual, spawn: guarded, default: { ...actual, spawn: guarded } };
});

const execute = promisify(execFile);
const cli = resolve("dist/bin/lcm.js");
const DEFAULT_PORT = loadDaemonConfig(join(tmpdir(), "lcm-port-guard-absent", "config.json")).daemon.port;
/** Stands in for the real daemon's pid: never a process this machine is running. */
const FAKE_DAEMON_PID = 2_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
  daemonSpawns.length = 0;
});

describe("the harness keeps the suite off the real daemon", () => {
  it("refuses exactly the port lcm resolves when no config names one", () => {
    expect(process.env.LCM_TEST_GUARDED_PORTS?.split(",").map(Number)).toContain(DEFAULT_PORT);
  });

  it("gives every test file an lcm home and a HOME that are not the user's", () => {
    const home = lcmHome();
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(home.startsWith(process.env.HOME!)).toBe(false);
  });

  it("ensureCore on the harness config neither probes, signals nor replaces a daemon on the default port", async () => {
    // A stale "real" daemon answers on the default port: the exact case ensureDaemon
    // replaces. Other ports reach the network as usual.
    const realFetch = globalThis.fetch.bind(globalThis);
    const probed: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (Number(url.port) === DEFAULT_PORT) {
        probed.push(url.href);
        return new Response(JSON.stringify({ status: "ok", version: "0.0.1", pid: FAKE_DAEMON_PID }));
      }
      return realFetch(input, init);
    });
    const realKill = process.kill.bind(process);
    const signalled: (string | number | undefined)[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== FAKE_DAEMON_PID) return realKill(pid, signal);
      if (signal !== 0) signalled.push(signal);
      return true;
    });

    const { port, daemon } = await ensureCore(createLcmPaths(lcmHome()));

    expect(probed).toEqual([]);
    expect(signalled).toEqual([]);
    expect(port).not.toBe(DEFAULT_PORT);
    expect(daemon.connected).toBe(false);
    for (const spawned of daemonSpawns) expect(spawned.env?.LCM_HOME).toBe(lcmHome());
  }, 20_000);

  it("a CLI child on the harness config stops no daemon on the default port", async () => {
    const { stdout, stderr } = await execute(process.execPath, [cli, "daemon", "stop"], { timeout: 15_000 });
    expect(stderr).not.toContain("[lcm test guard]");
    expect(stdout).toContain("lcm daemon was not running");
  });
});

describe("the port guard", () => {
  it("refuses a child whose lcm home has no config, at the port lcm falls back to", async () => {
    // The real fallback path: no config.json, so the child resolves the compiled-in default
    // port. It only asks /health, so a broken guard fails this test without disturbing the
    // daemon that may be listening there.
    const home = mkdtempSync(join(tmpdir(), "lcm-port-guard-bare-home-"));
    const guardDir = mkdtempSync(join(tmpdir(), "lcm-port-guard-log-"));
    const dist = (path: string) => JSON.stringify(pathToFileURL(resolve("dist/src", path)).href);
    const probeScript = [
      `import { loadDaemonConfig } from ${dist("daemon/config.js")};`,
      `import { checkDaemonHealth } from ${dist("daemon/lifecycle.js")};`,
      `import { createLcmPaths } from ${dist("lcm-paths.js")};`,
      `import { lcmHome } from ${dist("lcm-home.js")};`,
      "const { port } = loadDaemonConfig(createLcmPaths(lcmHome()).configPath).daemon;",
      "const health = await checkDaemonHealth(port);",
      "process.stdout.write(JSON.stringify({ port, health }));",
    ].join("\n");
    try {
      const { stdout, stderr } = await execute(process.execPath, ["--input-type=module", "-e", probeScript], {
        timeout: 15_000,
        env: {
          ...process.env,
          LCM_HOME: home,
          // Its own log, so the refusal this test provokes does not fail the file.
          LCM_TEST_GUARD_DIR: guardDir,
        },
      });
      expect(JSON.parse(stdout)).toEqual({ port: DEFAULT_PORT, health: null });
      expect(stderr).toContain(`[lcm test guard] refused to connect to port ${DEFAULT_PORT}`);
      expect(readdirSync(guardDir)).not.toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(guardDir, { recursive: true, force: true });
    }
  });

  it("refuses a CLI child that resolves a guarded port, so the daemon there is neither probed nor signalled", async () => {
    // The CLI reads its port from config, so the guarded port here is the one the config
    // names: a stand-in for the default port, which only the real daemon may use.
    const requests: string[] = [];
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const fake = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", version: "0.0.1", pid: victim.pid }));
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    const fakePort = (fake.address() as { port: number }).port;
    const home = mkdtempSync(join(tmpdir(), "lcm-port-guard-home-"));
    const guardDir = mkdtempSync(join(tmpdir(), "lcm-port-guard-log-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ daemon: { port: fakePort } }));
    try {
      const { stderr } = await execute(process.execPath, [cli, "daemon", "stop"], {
        timeout: 15_000,
        env: {
          ...process.env,
          LCM_HOME: home,
          LCM_TEST_GUARDED_PORTS: `${process.env.LCM_TEST_GUARDED_PORTS},${fakePort}`,
          // Its own log, so the refusal this test provokes does not fail the file.
          LCM_TEST_GUARD_DIR: guardDir,
        },
      });
      expect(requests).toEqual([]);
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
      expect(stderr).toContain(`[lcm test guard] refused to connect to port ${fakePort}`);
      expect(readdirSync(guardDir)).not.toEqual([]);
    } finally {
      victim.kill("SIGKILL");
      await new Promise<void>((done) => fake.close(() => done()));
      rmSync(home, { recursive: true, force: true });
      rmSync(guardDir, { recursive: true, force: true });
    }
  });

  it("refuses a child listen on a guarded port with EADDRINUSE and creates no listener", async () => {
    const guardedPort = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close((error) => error ? reject(error) : resolve(port));
      });
    });
    const guardDir = mkdtempSync(join(tmpdir(), "lcm-port-guard-log-"));
    const listenScript = [
      "import { createServer } from 'node:net';",
      "const server = createServer();",
      "setTimeout(() => process.exit(2), 1000).unref();",
      "server.once('error', (error) => {",
      "  process.stdout.write(JSON.stringify({ code: error.code, listening: server.listening }));",
      "  process.exit(0);",
      "});",
      "server.once('listening', () => process.exit(1));",
      `server.listen(${guardedPort}, '127.0.0.1');`,
    ].join("\n");
    try {
      const { stdout, stderr } = await execute(process.execPath, ["--input-type=module", "-e", listenScript], {
        timeout: 15_000,
        env: {
          ...process.env,
          LCM_TEST_GUARDED_PORTS: `${process.env.LCM_TEST_GUARDED_PORTS},${guardedPort}`,
          // Its own log, so the refusal this test provokes does not fail the file.
          LCM_TEST_GUARD_DIR: guardDir,
        },
      });
      expect(JSON.parse(stdout)).toEqual({ code: "EADDRINUSE", listening: false });
      expect(stderr).toContain(`[lcm test guard] refused to listen on port ${guardedPort}`);
      expect(readdirSync(guardDir)).not.toEqual([]);

      const server = createNetServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(guardedPort, "127.0.0.1", () => resolve());
      });
      expect(server.listening).toBe(true);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      rmSync(guardDir, { recursive: true, force: true });
    }
  });
});
