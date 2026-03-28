import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

describe("GET /stats", () => {
  let daemon: DaemonInstance;
  let port: number;

  beforeAll(async () => {
    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    port = daemon.address().port;
  });

  afterAll(async () => {
    await daemon.stop();
  });

  it("returns 200 with OverallStats shape including redactionCounts", { timeout: 60_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("conversations");
    expect(body).toHaveProperty("messages");
    expect(body).toHaveProperty("summaries");
    expect(body).toHaveProperty("redactionCounts");
    expect(body.redactionCounts).toMatchObject({
      builtIn: expect.any(Number),
      global: expect.any(Number),
      project: expect.any(Number),
      total: expect.any(Number),
    });
  });

  it("redactionCounts.total equals sum of built-in, global, and project", { timeout: 60_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      redactionCounts: { builtIn: number; global: number; project: number; total: number };
    };
    const rc = body.redactionCounts;
    expect(rc.total).toBe(rc.builtIn + rc.global + rc.project);
  });
});
