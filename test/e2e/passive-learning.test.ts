/**
 * Passive Learning Pipeline — E2E integration test
 *
 * Validates the full pipeline:
 *   event capture → sidecar DB → promotion → promoted store → restore surfacing
 *
 * Mocks only file paths to avoid writing to the real ~/.lossless-claude directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock eventsDbPath to redirect sidecar DB to temp dir ─────────────────────

let mockEventsDir: string;

vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
  eventsDbPath: (cwd: string) => {
    // Use a deterministic filename based on cwd hash (matching real logic)
    const { createHash } = require("node:crypto");
    const { realpathSync } = require("node:fs");
    let canonical: string;
    try { canonical = realpathSync(cwd); } catch { canonical = cwd; }
    const hash = createHash("sha256").update(canonical).digest("hex");
    return join(mockEventsDir, `${hash}.db`);
  },
}));

import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { EventsDb, type EventRow } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { extractPostToolEvents } from "../../src/hooks/extractors.js";

// For the full-cycle test we need the promote-events handler
import { createPromoteEventsHandler } from "../../src/daemon/routes/promote-events.js";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { projectId, projectDbPath } from "../../src/daemon/project.js";
import { loadDaemonConfig, type DaemonConfig } from "../../src/daemon/config.js";
import type { IncomingMessage, ServerResponse } from "node:http";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStdin(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    session_id: "e2e-passive-test",
    cwd: "/tmp/e2e-passive-project",
    daemon_port: 0, // no daemon to call
    ...overrides,
  });
}

/** Build a minimal mock ServerResponse that captures sendJson output. */
function mockResponse(): ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    end(data?: string) {
      if (data) res._body = JSON.parse(data);
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: unknown };
}

describe("Passive Learning E2E", { timeout: 30_000 }, () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "e2e-passive-"));
    mockEventsDir = join(tempDir, "events");
    projectDir = mkdtempSync(join(tmpdir(), "e2e-passive-project-"));
  });

  afterEach(() => {
    // Close any lingering connections
    closeLcmConnection();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  // ── Test A: Capture → sidecar ────────────────────────────────────────────

  it("captures AskUserQuestion event into sidecar DB with correct type/category/priority", async () => {
    const stdin = makeStdin({
      cwd: projectDir,
      tool_name: "AskUserQuestion",
      tool_input: { question: "Should we use TypeScript or JavaScript?" },
      tool_response: "TypeScript please",
    });

    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    // Open the sidecar DB and verify the event
    const dbPath = eventsDbPath(projectDir);
    const db = new EventsDb(dbPath);
    try {
      const events = db.getUnprocessed() as unknown as EventRow[];
      expect(events.length).toBe(1);

      const event = events[0];
      expect(event.type).toBe("decision");
      expect(event.category).toBe("decision");
      expect(event.priority).toBe(1);
      expect(event.source_hook).toBe("PostToolUse");
      expect(event.data).toContain("Should we use TypeScript or JavaScript?");
      expect(event.data).toContain("TypeScript please");
      expect(event.processed_at).toBeNull();
      expect(event.session_id).toBe("e2e-passive-test");
    } finally {
      db.close();
    }
  });

  // ── Test B: Full cycle — capture → promote → promoted store ──────────────

  it("full cycle: capture events → promote → verify promoted store and processed marks", async () => {
    // Step 1: Capture a decision event
    const decisionStdin = makeStdin({
      cwd: projectDir,
      tool_name: "AskUserQuestion",
      tool_input: { question: "Which database should we use?" },
      tool_response: "SQLite because it is embedded",
    });
    await handlePostToolUse(decisionStdin);

    // Step 2: Capture a plan event
    const planStdin = makeStdin({
      cwd: projectDir,
      tool_name: "ExitPlanMode",
      tool_response: "Plan approved by user",
    });
    await handlePostToolUse(planStdin);

    // Step 3: Capture a Bash error event
    const errorStdin = makeStdin({
      cwd: projectDir,
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_output: { isError: true },
    });
    await handlePostToolUse(errorStdin);

    // Verify 3 unprocessed events in sidecar
    const sidecarPath = eventsDbPath(projectDir);
    const sidecarDb = new EventsDb(sidecarPath);
    try {
      const unprocessed = sidecarDb.getUnprocessed() as unknown as EventRow[];
      expect(unprocessed.length).toBe(3);
    } finally {
      sidecarDb.close();
    }

    // Step 4: Set up the main project DB for promotion
    const mainDbPath = projectDbPath(projectDir);
    const mainDb = getLcmConnection(mainDbPath);
    runLcmMigrations(mainDb);
    closeLcmConnection(mainDbPath);

    // Step 5: Create and call the promote-events handler
    const configPath = join(tempDir, "config.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, "{}");
    const config = loadDaemonConfig(configPath, {}, {
      ...process.env,
      LCM_SUMMARY_PROVIDER: undefined,
    });
    const handler = createPromoteEventsHandler(config);

    const req = {} as IncomingMessage;
    const res = mockResponse();
    const body = JSON.stringify({ cwd: projectDir });

    await handler(req, res, body);

    expect(res._status).toBe(200);
    const promoteResult = res._body as { promoted: number; skipped: number; correlated: number; errors: number };
    expect(promoteResult.promoted).toBeGreaterThanOrEqual(2); // decision + plan at minimum
    expect(promoteResult.errors).toBe(0);

    // Step 6: Verify events are marked processed in sidecar
    const sidecarDb2 = new EventsDb(sidecarPath);
    try {
      const remaining = sidecarDb2.getUnprocessed() as unknown as EventRow[];
      expect(remaining.length).toBe(0);
    } finally {
      sidecarDb2.close();
    }

    // Step 7: Verify promoted store has the entries
    const mainDb2 = getLcmConnection(mainDbPath);
    const store = new PromotedStore(mainDb2);
    const pid = projectId(projectDir);
    const searchResults = store.search("database SQLite embedded", 10, undefined, pid);
    expect(searchResults.length).toBeGreaterThanOrEqual(1);

    // Check tags include passive-capture source
    const decisionResult = searchResults.find(r => r.content.includes("database"));
    expect(decisionResult).toBeDefined();
    expect(decisionResult!.tags).toContain("source:passive-capture");

    closeLcmConnection(mainDbPath);
  });

  // ── Test C: Negative path — unrecognized tool produces no events ─────────

  it("unrecognized tool produces no events", async () => {
    const stdin = makeStdin({
      cwd: projectDir,
      tool_name: "SomeUnknownTool",
      tool_input: { foo: "bar" },
    });

    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);

    // The sidecar DB should not even be created for unrecognized tools
    const events = extractPostToolEvents({
      tool_name: "SomeUnknownTool",
      tool_input: { foo: "bar" },
    });
    expect(events.length).toBe(0);
  });

  // ── Test D: Silent failure — bad input returns exitCode 0 ────────────────

  it("returns exitCode 0 even with malformed JSON input", async () => {
    const result = await handlePostToolUse("not valid json {{{");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns exitCode 0 when tool_name is missing", async () => {
    const result = await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_input: {},
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns exitCode 0 when session_id is missing", async () => {
    const result = await handlePostToolUse(JSON.stringify({
      tool_name: "AskUserQuestion",
      tool_input: { question: "test" },
    }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  // ── Test E: Promote with no events returns message ───────────────────────

  it("promote-events with empty sidecar returns no-events message", async () => {
    // Set up sidecar DB (empty) — just create the DB so it exists
    const sidecarPath = eventsDbPath(projectDir);
    const sidecarDb = new EventsDb(sidecarPath);
    sidecarDb.close();

    // Set up main DB
    const mainDbPath = projectDbPath(projectDir);
    const mainDb = getLcmConnection(mainDbPath);
    runLcmMigrations(mainDb);
    closeLcmConnection(mainDbPath);

    // Call handler
    const configPath = join(tempDir, "config2.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configPath, "{}");
    const config = loadDaemonConfig(configPath, {}, {
      ...process.env,
      LCM_SUMMARY_PROVIDER: undefined,
    });
    const handler = createPromoteEventsHandler(config);
    const req = {} as IncomingMessage;
    const res = mockResponse();

    await handler(req, res, JSON.stringify({ cwd: projectDir }));

    expect(res._status).toBe(200);
    const body = res._body as { promoted: number; skipped: number; message?: string };
    expect(body.promoted).toBe(0);
    expect(body.message).toBe("no unprocessed events");
  });

  // ── Test F: lcm_store is excluded (prevents feedback loop) ───────────────

  it("lcm_store tool is excluded to prevent feedback loops", async () => {
    const events1 = extractPostToolEvents({
      tool_name: "lcm_store",
      tool_input: { text: "some memory" },
    });
    expect(events1.length).toBe(0);

    const events2 = extractPostToolEvents({
      tool_name: "mcp__lcm__lcm_store",
      tool_input: { text: "some memory" },
    });
    // mcp__ prefix tools that include lcm_store should also be excluded
    expect(events2.length).toBe(0);
  });

  // ── Test G: Event sequencing ─────────────────────────────────────────────

  it("events within the same session get sequential seq numbers", async () => {
    // Insert 3 events in the same session
    for (let i = 0; i < 3; i++) {
      const stdin = makeStdin({
        cwd: projectDir,
        tool_name: "AskUserQuestion",
        tool_input: { question: `Question ${i}` },
        tool_response: `Answer ${i}`,
      });
      await handlePostToolUse(stdin);
    }

    const dbPath = eventsDbPath(projectDir);
    const db = new EventsDb(dbPath);
    try {
      const events = db.getUnprocessed() as unknown as EventRow[];
      expect(events.length).toBe(3);

      // seq should be 1, 2, 3
      const seqs = events.map(e => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  // ── Test H: Error capture via safeLogError ─────────────────────────────

  it("safeLogError writes to error_log table in sidecar DB", async () => {
    const { safeLogError, _resetCircuitBreaker } = await import("../../src/hooks/hook-errors.js");
    _resetCircuitBreaker();

    safeLogError("PostToolUse", new Error("test e2e error"), {
      cwd: projectDir,
      sessionId: "e2e-error-test",
    });

    const dbPath = eventsDbPath(projectDir);
    const db = new EventsDb(dbPath);
    try {
      const stats = db.getHealthStats();
      expect(stats.errors).toBe(1);
      expect(stats.lastError).toBeTruthy();
    } finally {
      db.close();
    }
  });

  // ── Test I: Pruning caps unprocessed events ──────────────────────────

  it("pruneUnprocessed caps events at maxRows", async () => {
    const dbPath = eventsDbPath(projectDir);
    const db = new EventsDb(dbPath);
    try {
      for (let i = 0; i < 20; i++) {
        db.insertEvent("e2e-prune-test", {
          type: "file", category: "pattern", data: `event-${i}`, priority: 3,
        }, "PostToolUse");
      }
      expect(db.getHealthStats().unprocessed).toBe(20);

      const result = db.pruneUnprocessed(10, 30);
      expect(result.pruned).toBe(10);
      expect(db.getHealthStats().unprocessed).toBe(10);

      // Verify prune was logged to error_log
      // Note: getHealthStats() filters out pruneUnprocessed/pruneErrorLog maintenance errors
      // to avoid noise in health stats, so we query the raw DB directly
      // Also: there's a potential race where the error log entry may not be written immediately
      let pruneLog: { c: number } | undefined;
      for (let attempts = 0; attempts < 3; attempts++) {
        pruneLog = db.raw().prepare(
          "SELECT COUNT(*) as c FROM error_log WHERE hook = 'maintenance:pruneUnprocessed'"
        ).get() as { c: number };
        if (pruneLog.c > 0) break;
        if (attempts < 2) {
          await new Promise(r => setTimeout(r, 10));
        }
      }
      expect(pruneLog!.c).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  // ── Test J: collectEventStats aggregation ────────────────────────────

  it("collectEventStats aggregates across sidecar DBs", async () => {
    // Create events in the project sidecar
    const dbPath = eventsDbPath(projectDir);
    const db = new EventsDb(dbPath);
    try {
      db.insertEvent("e2e-stats-test", {
        type: "decision", category: "decision", data: "test", priority: 1,
      }, "PostToolUse");
      db.logHookError("PostToolUse", new Error("test error"));
    } finally {
      db.close();
    }

    const { collectEventStats } = await import("../../src/db/events-stats.js");
    const stats = collectEventStats();
    expect(stats.captured).toBeGreaterThanOrEqual(1);
    expect(stats.errors).toBeGreaterThanOrEqual(1);
  });
});
