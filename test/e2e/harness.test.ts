import { describe, it, expect, afterAll } from "vitest";
import { createHarness, type HarnessHandle } from "./harness.js";

describe("E2E harness", { timeout: 30_000 }, () => {
  let handle: HarnessHandle | null = null;

  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it("creates and cleans up in mock mode", async () => {
    handle = await createHarness("mock");
    expect(handle.daemonPort).toBeGreaterThan(0);
    // Use raw fetch since /health is GET, not POST
    const res = await fetch(`http://127.0.0.1:${handle.daemonPort}/health`);
    const health = await res.json() as { status: string };
    expect(health.status).toBe("ok");
    await handle.cleanup();
    handle = null;
  });
});
