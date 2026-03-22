import { describe, it, expect, afterEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

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
});
