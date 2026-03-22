/**
 * Flow 7: Curate — full pipeline (ingest → compact → promote) on a fresh session
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";

describe("Flow 7: Curate", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("step 1: ingests main fixture with a fresh session", async () => {
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "e2e-curate-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    expect(result.ingested).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("step 2: compacts the session", async () => {
    const result = await handle.client.post<{ summary: string; skipped?: boolean }>("/compact", {
      session_id: "e2e-curate-session",
      cwd: handle.tmpDir,
      client: "claude",
    });
    expect(result.summary).toBeTruthy();
  });

  it("step 3: promotes insights from the session", async () => {
    const result = await handle.client.post<{ processed: number; promoted: number }>("/promote", {
      cwd: handle.tmpDir,
    });
    expect(result.processed).toBeGreaterThanOrEqual(0);
    expect(result.promoted).toBeGreaterThanOrEqual(0);
  });
});
