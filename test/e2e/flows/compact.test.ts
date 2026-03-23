/**
 * Flow 5: Compact — DAG summary node creation
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle, openProjectDb } from "../harness.js";

describe("Flow 5: Compact", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");

    // Prerequisite: ingest so there is data to compact
    await handle.client.post("/ingest", {
      session_id: "e2e-compact-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("creates DAG summary nodes", async () => {
    const result = await handle.client.post<{ summary: string; skipped?: boolean }>("/compact", {
      session_id: "e2e-compact-session",
      cwd: handle.tmpDir,
      client: "claude",
    });
    // Compact returns { summary: "..." } — check it ran
    expect(result.summary).toBeTruthy();

    // In mock mode the mock summarizer runs deterministically, so summary rows are
    // inserted. Assert that at least one summary was created.
    const { db, close } = openProjectDb(handle.tmpDir);
    try {
      const rows = db.prepare("SELECT COUNT(*) as cnt FROM summaries").get() as { cnt: number };
      // Mock summarizer always produces at least one summary after compaction
      expect(rows.cnt).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});
