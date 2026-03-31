/**
 * Continuous Learning — synthetic session quality validation
 *
 * Part 1: lcm_store round-trip — store a fact, find it via prompt-search
 * Part 2: Rolling ingest idempotency — second ingest of the same session returns ingested:0
 *
 * Quality assertions (promoted entries per category, noise ratio) require a
 * real LLM summarizer and are skipped here.
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle, openProjectDb } from "../e2e/harness.js";

describe("Continuous Learning", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  // ── Part 1: lcm_store round-trip ────────────────────────────────────────────

  it("stores a fact and finds it in the promoted table", async () => {
    const text = "Decision: we chose SQLite over Postgres because it is embedded and needs no setup.";

    // POST /store — should write to the promoted table
    const stored = await handle.client.post<{ stored: boolean; id: number | string }>("/store", {
      text,
      tags: ["type:decision"],
      cwd: handle.tmpDir,
    });
    expect(stored.stored).toBe(true);
    expect(stored.id).toBeTruthy();

    // Verify the row landed in the promoted table via direct DB inspection
    const { db, close } = openProjectDb(handle.tmpDir);
    try {
      const rows = db.prepare(
        "SELECT content, tags FROM promoted WHERE content LIKE ? LIMIT 1"
      ).all("%SQLite%") as Array<{ content: string; tags: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].content).toContain("SQLite");
      expect(JSON.parse(rows[0].tags)).toContain("type:decision");
    } finally {
      close();
    }

    // prompt-search should return a valid hints array (structural check)
    const search = await handle.client.post<{ hints: string[] }>("/prompt-search", {
      query: "SQLite Postgres embedded database",
      cwd: handle.tmpDir,
    });
    expect(Array.isArray(search.hints)).toBe(true);
  });

  // ── Part 2: Rolling ingest idempotency ──────────────────────────────────────

  it("first ingest of synthetic session stores messages", async () => {
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "cl-synthetic-session",
      cwd: handle.tmpDir,
      transcript_path: handle.syntheticFixturePath,
    });
    expect(result.ingested).toBeGreaterThan(0);
  });

  it("second ingest of same session returns ingested:0 (no duplicates)", async () => {
    const result = await handle.client.post<{ ingested: number; totalTokens: number }>("/ingest", {
      session_id: "cl-synthetic-session",
      cwd: handle.tmpDir,
      transcript_path: handle.syntheticFixturePath,
    });
    expect(result.ingested).toBe(0);
  });

  // ── Skipped: quality assertions require real LLM ─────────────────────────────

  it.skip("promoted table contains at least one entry per category (requires LLM)", () => {
    // Would assert: decision, preference, root-cause, pattern, gotcha, solution, workflow
    // all present in the promoted table after compact+promote with a real summarizer.
  });

  it.skip("noise ratio is below 50% (requires LLM)", () => {
    // Would assert: noise entries (greetings, yes/no, status updates) not promoted.
  });
});
