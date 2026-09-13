import { utimesSync, statSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonOwnership, ensureDaemon, isOlderVersion, isStaleDaemon, registerDaemonActivity, stopDaemon } from "../../src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureDaemon", () => {
  it.each(["/checkout/bin/lcm.ts", "/checkout/dist/bin/lcm.js"])("preserves only source loader flags for %s", async (entrypoint) => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-source-spawn-"));
    tempDirs.push(tempDir);
    const spawnMock = vi.fn().mockReturnValue({ pid: 12345, unref: vi.fn() });
    const originalArgv = process.argv;
    const originalExecArgv = process.execArgv;
    process.argv = [process.execPath, entrypoint];
    process.execArgv = ["--inspect=9229", "--require", "/tsx/preflight.cjs", "--import=file:///tsx/loader.mjs", "--eval", "not child code"];
    try {
      await ensureDaemon({
        port: 1, pidFilePath: join(tempDir, "daemon.pid"), spawnTimeoutMs: 100,
        _fetchOverride: (async () => { throw new Error("offline"); }) as typeof fetch,
        _skipHealthWait: true, _spawnOverride: spawnMock as any,
      });
      expect(spawnMock.mock.calls[0][1]).toEqual([
        ...(entrypoint.endsWith(".ts") ? ["--require", "/tsx/preflight.cjs", "--import=file:///tsx/loader.mjs"] : []),
        entrypoint, "daemon", "start", "--automatic",
      ]);
    } finally {
      process.argv = originalArgv;
      process.execArgv = originalExecArgv;
    }
  });

  it("connects to existing healthy daemon", async () => {
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    try {
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 5000,
        _skipSpawn: true,
      });
      expect(result.connected).toBe(true);
      expect(result.port).toBe(port);
      expect(result.spawned).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it("returns connected=false when daemon is not running and spawn is skipped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-no-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });
    expect(result.connected).toBe(false);
  });

  it("cleans up stale PID file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-stale-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "99999999");

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("detects version mismatch and returns not connected when spawn skipped", async () => {
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-ver-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    try {
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 1000,
        expectedVersion: "99.99.99", // doesn't match running daemon
        _skipSpawn: true,
      });
      // With _skipSpawn, it kills old daemon but can't spawn new → connected=false
      expect(result.connected).toBe(false);
    } finally {
      // daemon may have been killed by version mismatch logic
      try { await daemon.stop(); } catch { /* may already be stopped */ }
    }
  });

  it("treats a build mismatch like a version mismatch", async () => {
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-build-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    try {
      const sameBuild = await ensureDaemon({ port, pidFilePath: pidFile, spawnTimeoutMs: 1000, expectedBuild: undefined, _skipSpawn: true });
      expect(sameBuild.connected).toBe(true);
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 1000,
        expectedBuild: "2000-01-01T00:00:00.000Z",
        _skipSpawn: true,
      });
      expect(result.connected).toBe(false);
    } finally {
      try { await daemon.stop(); } catch { /* may already be stopped */ }
    }
  });

  it("isStaleDaemon accepts daemons that report no build", () => {
    expect(isStaleDaemon({ status: "ok", version: "1.0.0" }, { version: "1.0.0", build: "b1" })).toBe(false);
    expect(isStaleDaemon({ status: "ok", version: "1.0.0", build: "b0" }, { version: "1.0.0", build: "b1" })).toBe(true);
    expect(isStaleDaemon({ status: "ok", version: "0.9.0", build: "b1" }, { version: "1.0.0", build: "b1" })).toBe(true);
    expect(isStaleDaemon({ status: "ok" }, { version: "1.0.0", build: "b1" })).toBe(false);
  });

  it("daemonOwnership: newest wins, older callers connect within the compatible component", () => {
    const own = (daemon: string, caller: string) => daemonOwnership({ status: "ok", version: daemon }, { version: caller });
    expect(own("0.12.0", "0.12.0")).toBe("current");
    expect(own("0.12.0", "0.13.0")).toBe("restart");
    expect(own("0.13.1", "0.13.0")).toBe("older-caller");
    expect(own("0.13.0", "0.12.9")).toBe("incompatible");
    expect(own("1.2.0", "1.0.0")).toBe("older-caller");
    expect(own("2.0.0", "1.9.9")).toBe("incompatible");
    expect(own("1.0.0", "2.0.0")).toBe("restart");
    // A newer daemon is never restarted over a build mismatch.
    expect(daemonOwnership({ status: "ok", version: "0.13.1", build: "b0" }, { version: "0.13.0", build: "b1" })).toBe("older-caller");
    // A prerelease is not a release: it falls back to string equality, so the release replaces it.
    expect(own("0.13.0-rc.1", "0.13.0")).toBe("restart");
    expect(own("0.13.0", "0.12.0-rc.1")).toBe("older-caller"); // a prerelease caller never replaces a release daemon
    expect(isOlderVersion("0.12.0", "0.13.0")).toBe(true);
    expect(isOlderVersion("0.13.1", "0.13.0")).toBe(false);
    expect(isOlderVersion("latest", "0.13.0")).toBe(false);
  });

  it("ensureDaemon refuses an incompatible newer daemon without touching it", async () => {
    const health = { status: "ok", version: "0.13.0", pid: process.pid };
    const fetchFn = (async () => ({ ok: true, json: async () => health })) as unknown as typeof fetch;
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-incompat-"));
    tempDirs.push(tempDir);
    const result = await ensureDaemon({
      port: 1, pidFilePath: join(tempDir, "daemon.pid"), spawnTimeoutMs: 10,
      expectedVersion: "0.12.0", _skipSpawn: true, _fetchOverride: fetchFn,
    });
    expect(result).toMatchObject({ connected: false, spawned: false, ownership: "incompatible", daemonVersion: "0.13.0" });
  });

  it("a scan prunes a dead-pid marker but keeps one for a live process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-markers-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const unregister = registerDaemonActivity(pidFile); // live marker for process.pid
    const deadMarker = join(tempDir, "tmp", `daemon.starting.999999.${randomUUID()}`);
    writeFileSync(deadMarker, "");
    const fetchFn = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const stopping = stopDaemon({ port: 1, pidFilePath: pidFile, timeoutMs: 50, _fetchOverride: fetchFn });
    // stopDaemon scans markers synchronously before its first await.
    expect(existsSync(deadMarker)).toBe(false);
    const remaining = readdirSync(join(tempDir, "tmp"));
    expect(remaining.some((name) => name.startsWith(`daemon.starting.${process.pid}.`))).toBe(true);
    unregister();
    await stopping;
  });

  it("a registration after a simulated crash removes the abandoned marker", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-crash-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    mkdirSync(join(tempDir, "tmp"), { recursive: true });
    const crashedMarker = join(tempDir, "tmp", `daemon.starting.999999.${randomUUID()}`);
    writeFileSync(crashedMarker, ""); // release() never called — simulated crash
    const unregister = registerDaemonActivity(pidFile); // next registration, another process
    expect(existsSync(crashedMarker)).toBe(false);
    unregister();
  });

  it("prunes a live process's marker once it outlives the age limit", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-aged-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    mkdirSync(join(tempDir, "tmp"), { recursive: true });
    // This process is alive, so only the age rule can remove it.
    const aged = join(tempDir, "tmp", `daemon.starting.${process.pid}.${randomUUID()}`);
    writeFileSync(aged, "");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(aged, longAgo, longAgo);

    const unregister = registerDaemonActivity(pidFile); // any scan prunes it
    expect(existsSync(aged)).toBe(false);
    unregister();
  });

  it("keeps an aged marker a pre-upgrade version left behind while its process is alive", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-legacyaged-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    // Beside daemon.pid, owned by this live process, older than the age limit: pre-upgrade
    // writers never refresh, so age must not be read as death.
    const aged = join(tempDir, `daemon.starting.${process.pid}.${randomUUID()}`);
    writeFileSync(aged, "");
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(aged, longAgo, longAgo);

    const unregister = registerDaemonActivity(pidFile);
    expect(existsSync(aged)).toBe(true);
    unregister();
  });

  it("refreshes its own marker so a long registration is not aged out", () => {
    vi.useFakeTimers();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-refresh-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const unregister = registerDaemonActivity(pidFile);
    try {
      const own = readdirSync(join(tempDir, "tmp"))
        .find((name) => name.startsWith(`daemon.starting.${process.pid}.`))!;
      const path = join(tempDir, "tmp", own);
      const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(path, longAgo, longAgo);

      vi.advanceTimersByTime(16 * 60 * 1000); // past one refresh interval
      expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60 * 60 * 1000);
    } finally {
      unregister();
      vi.useRealTimers();
    }
  });

  it("a registration prunes a marker an older version left beside the PID file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-legacy-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const legacyMarker = join(tempDir, `daemon.starting.999999.${randomUUID()}`);
    writeFileSync(legacyMarker, ""); // written beside daemon.pid, as versions before the tmp move did
    const unregister = registerDaemonActivity(pidFile);
    expect(existsSync(legacyMarker)).toBe(false);
    unregister();
  });

  it("stopDaemon proceeds when the markers directory cannot be read", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-stopscan-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const markers = join(tempDir, "tmp");
    mkdirSync(markers, { recursive: true });
    chmodSync(markers, 0o300); // write+traverse, no list
    try {
      const fetchFn = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
      const result = await stopDaemon({ port: 1, pidFilePath: pidFile, timeoutMs: 50, _fetchOverride: fetchFn });
      expect(result.stopped).toBe(true);
    } finally {
      chmodSync(markers, 0o700);
    }
  });

  it("a registration still writes its own marker when the sweep cannot read the directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-unreadable-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const markers = join(tempDir, "tmp");
    mkdirSync(markers, { recursive: true });
    chmodSync(markers, 0o300); // write+traverse, no list: readdirSync throws EACCES, writeFileSync still works
    try {
      const unregister = registerDaemonActivity(pidFile);
      chmodSync(markers, 0o700);
      expect(readdirSync(markers).some((name) => name.startsWith(`daemon.starting.${process.pid}.`))).toBe(true);
      unregister();
    } finally {
      chmodSync(markers, 0o700);
    }
  });

  it("stopDaemon reports not running when nothing listens and no PID file exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-stop-"));
    tempDirs.push(tempDir);
    const result = await stopDaemon({ port: 1, pidFilePath: join(tempDir, "daemon.pid"), timeoutMs: 500 });
    expect(result.stopped).toBe(true);
    expect(result.pid).toBeUndefined();
  });

  it("stopDaemon removes a stale PID file for a dead process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-stop2-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "999999");
    const result = await stopDaemon({ port: 1, pidFilePath: pidFile, timeoutMs: 500 });
    expect(result.stopped).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not connect when health wait returns a daemon with mismatched version", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-healthver-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    // Stale PID — process.kill will fail silently
    writeFileSync(pidFile, "9999999");

    // Simulate an old wrong-version daemon that is permanently running (always answers health)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok", version: "0.0.0", uptime: 100 }),
    } as Response);

    // Spawn override does nothing (simulates new process failing to bind occupied port)
    const spawnMock = vi.fn().mockReturnValue({ pid: undefined, unref: vi.fn() });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 600,
      expectedVersion: "99.99.99",
      _fetchOverride: mockFetch as any,
      _spawnOverride: spawnMock as any,
    });

    // Must NOT connect to the daemon that answered with wrong version
    expect(result.connected).toBe(false);
  });

  it("spawns a caller-specified command instead of process.argv[1] when provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-spawn-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    const spawnMock = vi.fn().mockReturnValue({ pid: 12345, unref: vi.fn() });

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 100,
      spawnCommand: "lcm",
      spawnArgs: ["daemon", "start"],
      _skipHealthWait: true,
      _spawnOverride: spawnMock as any,
    });

    expect(result.connected).toBe(false);
    expect(result.spawned).toBe(true);
    // Only a listening child owns daemon.pid; the spawner must not race its
    // startup registration or overwrite a concurrently successful child.
    expect(existsSync(pidFile)).toBe(false);
    expect(spawnMock).toHaveBeenCalledWith(
      "lcm",
      ["daemon", "start"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
  });
});
