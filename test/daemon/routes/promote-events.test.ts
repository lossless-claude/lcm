import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createPromoteEventsHandler } from "../../../src/daemon/routes/promote-events.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

// Mock eventsDbPath to point at our temp dir
vi.mock("../../../src/db/events-path.js", () => ({
  eventsDbPath: vi.fn(),
}));

// Mock deduplicateAndInsert to track calls without needing real FTS5
vi.mock("../../../src/promotion/dedup.js", () => ({
  deduplicateAndInsert: vi.fn().mockResolvedValue("mock-id"),
}));

// Import the mocked modules
import { eventsDbPath } from "../../../src/db/events-path.js";
import { deduplicateAndInsert } from "../../../src/promotion/dedup.js";

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
      promotionThresholds: {
        minDepth: 1,
        compressionRatio: 0.1,
        keywords: { decision: ["decided"] },
        architecturePatterns: [],
        dedupBm25Threshold: 15,
        dedupCandidateLimit: 100,
        eventConfidence: {
          decision: 0.5,
          plan: 0.7,
          errorFix: 0.4,
          batch: 0.3,
          pattern: 0.2,
        },
        reinforcementBoost: 0.3,
        maxConfidence: 1,
        insightsMaxAgeDays: 90,
      },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: { provider: "disabled", model: "", apiKey: "", baseURL: "" },
    summarizer: { mock: true },
    security: { sensitivePatterns: [] },
    hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
  } as DaemonConfig;
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function setupProjectDb(cwd: string): DatabaseSync {
  const dbPath = projectDbPath(cwd);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("promote-events route", () => {
  let dir: string;
  let sidecarPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promote-events-test-"));
    sidecarPath = join(dir, "events.db");
    vi.mocked(eventsDbPath).mockReturnValue(sidecarPath);
    vi.mocked(deduplicateAndInsert).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("promotes priority 1 events via deduplicateAndInsert", async () => {
    // Seed sidecar with a decision event
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "use SQLite", priority: 1 }, "PostToolUse");
    edb.close();

    // Set up project DB so PromotedStore can be constructed
    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(1);
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(1);

    // Verify it was called with decision confidence
    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call.confidence).toBe(0.5);
    expect(call.tags).toContain("type:preference");
    expect(call.tags).toContain("source:passive-capture");
  });

  it("correlates error→fix pairs within session", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "error_tool", category: "error", data: "Bash error: npm install", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "env_install", category: "env", data: "npm install --legacy-peer-deps", priority: 2 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    // Both events should be promoted
    expect(result.promoted).toBeGreaterThanOrEqual(2);
    expect(result.correlated).toBeGreaterThanOrEqual(1);
  });

  it("marks all events as processed after promotion", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    // Re-open events DB and check that nothing is unprocessed
    const edb2 = new EventsDb(sidecarPath);
    const remaining = edb2.getUnprocessed();
    edb2.close();
    expect(remaining).toHaveLength(0);
  });

  it("bootstraps repeated priority 3 file patterns without a seeded memory", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s2", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(2);
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(2);

    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call.confidence).toBe(0.5);
    expect(call.tags).toContain("signal:reinforced");
    expect(call.tags).toContain("type:pattern");
  });

  it("is idempotent — skips already-processed events", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "test", priority: 1 }, "PostToolUse");
    const events = edb.getUnprocessed();
    edb.markProcessed([events[0].event_id]);
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.message).toBe("no unprocessed events");
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when cwd is missing", async () => {
    const handler = createPromoteEventsHandler(makeConfig());
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({}));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody().error).toBe("cwd is required");
  });
});
