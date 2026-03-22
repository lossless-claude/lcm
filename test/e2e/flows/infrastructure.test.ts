/**
 * E2E Flow Tests: Infrastructure (Flows 11, 12, 13)
 *
 * Flow 11: MCP transport — daemon-backed tools respond, local tools return definitions
 * Flow 12: Doctor — reports results without crashing
 * Flow 13: Teardown — cleanup removes temp dir and project data
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createHarness, type HarnessHandle } from "../harness.js";
import { existsSync } from "node:fs";

let handle: HarnessHandle | null = null;

beforeAll(async () => {
  handle = await createHarness("mock");

  // Ingest some data so daemon-backed tools have content to operate on
  await handle.client.post("/ingest", {
    session_id: "e2e-infra-session",
    cwd: handle.tmpDir,
    messages: [
      { role: "user", content: "We are using SQLite as the database backend.", tokenCount: 10 },
      { role: "assistant", content: "Great choice — SQLite is zero-infrastructure.", tokenCount: 10 },
      { role: "user", content: "What about PostgreSQL for production?", tokenCount: 8 },
      { role: "assistant", content: "SQLite is fine for most production workloads.", tokenCount: 10 },
    ],
  });
}, 60_000);

afterAll(async () => {
  if (handle) {
    await handle.cleanup();
    handle = null;
  }
});

describe("Flow 11: MCP transport", { timeout: 60_000 }, () => {
  it("daemon-backed tools respond (grep, search, store)", async () => {
    const h = handle!;

    // grep
    const grep = await h.client.post("/grep", { query: "database", cwd: h.tmpDir });
    expect(grep).toBeDefined();

    // search
    const search = await h.client.post("/search", { query: "SQLite", cwd: h.tmpDir });
    expect(search).toBeDefined();

    // store
    const store = await h.client.post("/store", {
      text: "E2E test memory: infrastructure verified",
      tags: ["test", "e2e"],
      cwd: h.tmpDir,
    });
    expect(store).toBeDefined();
  });

  it("MCP tool definitions expose exactly 7 tools", async () => {
    const { getMcpToolDefinitions } = await import("../../../src/mcp/server.js");
    const tools = getMcpToolDefinitions();
    expect(tools).toHaveLength(7);
  });

  it("MCP tool definitions include all expected tool names", async () => {
    const { getMcpToolDefinitions } = await import("../../../src/mcp/server.js");
    const tools = getMcpToolDefinitions();
    const names = tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["lcm_describe", "lcm_doctor", "lcm_expand", "lcm_grep", "lcm_search", "lcm_stats", "lcm_store"]);
  });
});

describe("Flow 12: Doctor", { timeout: 60_000 }, () => {
  it("doctor reports results with non-empty text", async () => {
    const { runDoctor, formatResultsPlain } = await import("../../../src/doctor/doctor.js");
    const results = await runDoctor();
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    const text = formatResultsPlain(results);
    expect(text).toBeDefined();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("Flow 13: Teardown", { timeout: 60_000 }, () => {
  it("cleanup removes temp dir and project data", async () => {
    const h = handle!;
    const tmpDir = h.tmpDir;

    await h.cleanup();
    handle = null; // prevent afterAll from double-cleanup

    expect(existsSync(tmpDir)).toBe(false);
  });
});
