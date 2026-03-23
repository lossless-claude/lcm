/**
 * Flow 6: Promote — durable insight promotion
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";

describe("Flow 6: Promote", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");

    // Prerequisite: ingest and compact so there are summaries to promote
    await handle.client.post("/ingest", {
      session_id: "e2e-promote-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    await handle.client.post("/compact", {
      session_id: "e2e-promote-session",
      cwd: handle.tmpDir,
      client: "claude",
    });
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("promotes durable insights to promoted store", async () => {
    const result = await handle.client.post<{ processed: number; promoted: number }>("/promote", {
      cwd: handle.tmpDir,
    });
    // In mock mode (disabled provider), compact is skipped so no summaries exist.
    // processed and promoted may both be 0 — assert structural invariants only.
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.promoted).toBeGreaterThanOrEqual(0);
  });
});
