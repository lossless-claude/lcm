import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDaemon, isStaleDaemon, stopDaemon } from "../../src/daemon/lifecycle.js";

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
