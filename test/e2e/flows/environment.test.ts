/**
 * Flow 1: Environment — daemon health check
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";

describe("Flow 1: Environment", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("daemon responds to health check with version", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.daemonPort}/health`);
    const health = await res.json() as { status: string; version: string; uptime: number };
    expect(health.status).toBe("ok");
    expect(health.version).toBeTruthy();
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });
});
