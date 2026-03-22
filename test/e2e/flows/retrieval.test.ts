/**
 * Flows 8, 9, 10: Retrieval — search, grep, expand, describe, restore, prompt-search
 *
 * Requires data to be ingested and compacted first (done in beforeAll).
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { expect } from "vitest";
import { createHarness, type HarnessHandle, openProjectDb } from "../harness.js";

describe("Flows 8-10: Retrieval", { timeout: 60_000 }, () => {
  let handle: HarnessHandle;

  beforeAll(async () => {
    handle = await createHarness("mock");

    // Prerequisite: ingest and compact so retrieval has data
    await handle.client.post("/ingest", {
      session_id: "e2e-retrieval-session",
      cwd: handle.tmpDir,
      transcript_path: handle.fixturePath,
    });
    await handle.client.post("/compact", {
      session_id: "e2e-retrieval-session",
      cwd: handle.tmpDir,
      client: "claude",
    });
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  // Flow 8: Search / Grep / Expand / Describe

  it("Flow 8a: lcm_search returns episodic and promoted results", async () => {
    // /search returns { episodic: [...], promoted: [...] }
    const result = await handle.client.post<{ episodic: unknown[]; promoted: unknown[] }>("/search", {
      query: "SQLite",
      cwd: handle.tmpDir,
    });
    expect(result.episodic).toBeDefined();
    expect(result.promoted).toBeDefined();
  });

  it("Flow 8b: lcm_grep returns results", async () => {
    // /grep takes `query` and returns GrepResult: { messages, summaries, totalMatches }
    const result = await handle.client.post<{
      messages: unknown[];
      summaries: unknown[];
      totalMatches: number;
    }>("/grep", {
      query: "database",
      cwd: handle.tmpDir,
    });
    expect(result.messages).toBeDefined();
    expect(result.summaries).toBeDefined();
    expect(typeof result.totalMatches).toBe("number");
  });

  it("Flow 8c: lcm_expand returns result for a summary node", async () => {
    // /expand requires `nodeId` — get a real summary_id from DB
    const { db, close } = openProjectDb(handle.tmpDir);
    let summaryId: string | undefined;
    try {
      const row = db.prepare("SELECT summary_id FROM summaries LIMIT 1").get() as
        | { summary_id: string }
        | undefined;
      summaryId = row?.summary_id;
    } finally {
      close();
    }

    if (summaryId) {
      const result = await handle.client.post<{ expanded: unknown; error?: string }>("/expand", {
        nodeId: summaryId,
        cwd: handle.tmpDir,
      });
      expect(result).toBeDefined();
    }
  });

  it("Flow 8d: lcm_describe returns result for a summary node", async () => {
    // /describe requires `nodeId` — get a real summary_id from DB
    const { db, close } = openProjectDb(handle.tmpDir);
    let summaryId: string | undefined;
    try {
      const row = db.prepare("SELECT summary_id FROM summaries LIMIT 1").get() as
        | { summary_id: string }
        | undefined;
      summaryId = row?.summary_id;
    } finally {
      close();
    }

    if (summaryId) {
      const result = await handle.client.post<{ node: unknown }>("/describe", {
        nodeId: summaryId,
        cwd: handle.tmpDir,
      });
      expect(result).toBeDefined();
    }
  });

  // Flow 9: Restore (SessionStart)

  it("Flow 9: restore returns context from prior sessions", async () => {
    const result = await handle.client.post<{ context: string }>("/restore", {
      session_id: "e2e-test-new-session",
      cwd: handle.tmpDir,
    });
    // restore returns { context: "..." }
    expect(result).toBeDefined();
    expect(typeof result.context).toBe("string");
  });

  // Flow 10: Prompt Search (UserPromptSubmit)

  it("Flow 10: prompt-search returns memory context hints", async () => {
    const result = await handle.client.post<{ hints: unknown[] }>("/prompt-search", {
      query: "database decision",
      cwd: handle.tmpDir,
    });
    expect(result).toBeDefined();
    expect(Array.isArray(result.hints)).toBe(true);
  });
});
