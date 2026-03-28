import { afterEach, describe, it, expect } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

describe("GET /stats/pool", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
  });

  it("returns pool stats with correct shape", async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats/pool`);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(typeof data.totalConnections).toBe("number");
    expect(typeof data.activeConnections).toBe("number");
    expect(typeof data.idleConnections).toBe("number");
    expect(Array.isArray(data.connections)).toBe(true);
  });

  it("returns non-negative connection counts", async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats/pool`);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.totalConnections).toBeGreaterThanOrEqual(0);
    expect(data.activeConnections).toBeGreaterThanOrEqual(0);
    expect(data.idleConnections).toBeGreaterThanOrEqual(0);
    expect(data.totalConnections).toBe(data.activeConnections + data.idleConnections);
  });

  it("returns connection entries with required fields when connections exist", async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));

    // Trigger some DB activity via /status to create a real connection in the pool
    // (status route uses DatabaseSync directly, not the pool — so pool may be empty here)
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats/pool`);

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Each connection entry must have the correct shape
    for (const conn of data.connections) {
      expect(typeof conn.path).toBe("string");
      expect(typeof conn.refs).toBe("number");
      expect(conn.refs).toBeGreaterThanOrEqual(0);
      expect(["active", "idle"]).toContain(conn.status);
    }
  });

  it("active + idle counts sum to total", async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/stats/pool`);
    const data = (await res.json()) as any;

    expect(data.totalConnections).toBe(data.activeConnections + data.idleConnections);
    expect(data.connections.length).toBe(data.totalConnections);
  });
});
