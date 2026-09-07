import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";

describe("DaemonClient", () => {
  let daemon: DaemonInstance | undefined;
  let rawServer: Server | undefined;
  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = undefined; }
    if (rawServer) { await new Promise<void>((r) => rawServer!.close(() => r())); rawServer = undefined; }
  });

  it("checks health", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
    expect((await client.health())?.status).toBe("ok");
  });

  it("returns null when daemon not running", async () => {
    expect(await new DaemonClient("http://127.0.0.1:19999").health()).toBeNull();
  });

  it("uses the auth token for protected GET routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-client-auth-"));
    const tokenPath = join(dir, "daemon.token");
    ensureAuthToken(tokenPath);

    try {
      daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }), { tokenPath });
      const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, tokenPath);
      const poolStats = await client.get<{ totalConnections: number }>("/stats/pool");
      expect(poolStats.totalConnections).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression for issue #275: undici's default 300s headersTimeout made `fetch`
  // report FAILED (fetch failed) at exactly 5.0m for long-running /compact jobs,
  // even though the daemon completed them. node:http has no default header
  // timeout, so a slow POST must now succeed.
  it("waits for slow POST responses without a client-side header timeout", async () => {
    rawServer = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // Delay well past what any reasonable default header timeout would be
        // (undici would have cut this off at 300s; we simulate with 250ms).
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, delayed: true }));
        }, 250);
      });
    });
    await new Promise<void>((r) => rawServer!.listen(0, "127.0.0.1", r));
    const port = (rawServer!.address() as AddressInfo).port;

    const client = new DaemonClient(`http://127.0.0.1:${port}`);
    const start = Date.now();
    const result = await client.post<{ ok: boolean; delayed: boolean }>("/compact", { session_id: "s", cwd: "/x" });
    expect(result.ok).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  it("surfaces non-2xx as an Error with .status and .body (not a network error)", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`);
    // POST /compact without session_id/cwd -> 400 from the route
    const err = await client.post("/compact", {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError); // must NOT look like a network error
    expect(err.status).toBe(400);
    expect(typeof err.body?.error).toBe("string");
  });

  it("surfaces connection failures as TypeError so MCP auto-restart fires", async () => {
    const client = new DaemonClient("http://127.0.0.1:19999");
    const err = await client.post("/store", { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  it("marks caller-supplied timeouts as TimeoutError TypeErrors", async () => {
    rawServer = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => { /* never respond */ });
    });
    await new Promise<void>((r) => rawServer!.listen(0, "127.0.0.1", r));
    const port = (rawServer!.address() as AddressInfo).port;

    const client = new DaemonClient(`http://127.0.0.1:${port}`);
    const err = await client.post("/compact", { session_id: "s", cwd: "/x" }, { timeoutMs: 100 }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toMatch(/timed out/);
  });
});
