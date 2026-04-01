import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { ensureAuthToken } from "../../src/daemon/auth.js";

describe("DaemonClient", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

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
});
