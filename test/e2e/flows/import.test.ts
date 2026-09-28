/**
 * Flows 2, 3, 4: Import — ingest, idempotent re-import, subagent import
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle, openProjectDb } from "../harness.js";

describe("Flows 2-4: Import", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it("Flow 2: ingests fixture transcript into SQLite", async () => {
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "e2e-test-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    expect(result.ingested).toBeGreaterThan(0);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it("Flow 3: re-import returns ingested:0 (no duplicates)", async () => {
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "e2e-test-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    expect(result.ingested).toBe(0);
  });

  it("Flow 4: ingests subagent transcript", async () => {
    const result = await handle.client.post<{ ingested: number }>("/ingest", {
      session_id: "e2e-test-subagent",
      cwd: handle.tmpDir,
      transcript_path: handle.fixtureSubagentPath,
    });
    expect(result.ingested).toBeGreaterThan(0);
  });

  it("Flow 5: skips sessions marked in session_ingest_log", async () => {
    // Mark a session complete after its transcript was last written
    await handle.client.post("/session-complete", {
      session_id: "e2e-test-skip-me",
      cwd: handle.tmpDir,
      message_count: 42,
    });
    const { db, close } = openProjectDb(handle.tmpDir);
    try {
      expect(db.prepare("SELECT 1 FROM session_ingest_log WHERE session_id = ?").get("e2e-test-skip-me")).toBeDefined();
    } finally {
      close();
    }

    // Try to import that unchanged transcript with that session_id
    // The import should skip it (return ingested:0, totalTokens:0)
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "e2e-test-skip-me",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath, // reuse the existing fixture
    });

    expect(result.ingested).toBe(0);
    expect(result.totalTokens).toBe(0);
  });
});
