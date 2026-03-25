import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken, readAuthToken } from "../../src/daemon/auth.js";

describe("daemon server", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("starts and responds to /health", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const port = daemon.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });

  it("health endpoint returns version", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json() as { status: string; version: string; uptime: number };
      expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(data.status).toBe("ok");
    } finally {
      await daemon.stop();
    }
  });

  it("returns 404 for unknown routes", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/nope`);
    expect(res.status).toBe(404);
  });

  it("returns 413 when request body exceeds 10 MB", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const port = daemon.address().port;
    const bigBody = "x".repeat(11 * 1024 * 1024); // 11 MB
    const res = await fetch(`http://127.0.0.1:${port}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });
});

describe("daemon idle timeout", () => {
  it("calls onIdle after idle timeout", async () => {
    let idleCalled = false;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 200;
    const daemon = await createDaemon(config, { onIdle: () => { idleCalled = true; } });

    // Wait for idle timeout
    await new Promise(r => setTimeout(r, 400));

    expect(idleCalled).toBe(true);
    expect(daemon.idleTriggered).toBe(true);
    await daemon.stop();
  });

  it("resets idle timer on request", async () => {
    let idleCalled = false;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 300;
    const daemon = await createDaemon(config, { onIdle: () => { idleCalled = true; } });
    const port = daemon.address().port;

    // Make requests to keep alive
    await fetch(`http://127.0.0.1:${port}/health`);
    await new Promise(r => setTimeout(r, 200));
    await fetch(`http://127.0.0.1:${port}/health`);
    await new Promise(r => setTimeout(r, 200));

    // Should still be alive (timer reset each time)
    expect(idleCalled).toBe(false);
    expect(daemon.idleTriggered).toBe(false);

    await daemon.stop();
  });
});

describe("daemon auth", () => {
  it("returns 401 for POST without auth token when tokenPath is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(401);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows GET /health without auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv2-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows POST with valid Bearer token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-authsrv3-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);
    const token = readAuthToken(tokenPath)!;
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config, { tokenPath });
    const port = daemon.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ text: "hi", cwd: dir }),
      });
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon proxy integration", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("accepts proxyManager option and calls start on daemon creation", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    expect(mockProxy.start).toHaveBeenCalled();
  });

  it("calls proxyManager.stop() on daemon shutdown", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    await daemon.stop();
    expect(mockProxy.stop).toHaveBeenCalled();
    daemon = undefined; // already stopped
  });

  it("continues without error when proxyManager.start() rejects", async () => {
    const mockProxy = {
      start: vi.fn().mockRejectedValue(new Error("spawn failed")),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(false),
      port: 3456,
      available: false,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    // Daemon should still be running
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});
