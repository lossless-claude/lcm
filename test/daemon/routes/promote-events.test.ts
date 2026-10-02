import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createPromoteEventsHandler } from "../../../src/daemon/routes/promote-events.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { extractUserPromptEvents } from "../../../src/hooks/extractors.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());
const BACKLOG = 20;

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
      autoCompactMinTokens: 10000,
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
  const dbPath = projectDbPath(cwd, paths);
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

    const handler = createPromoteEventsHandler(makeConfig(), paths);
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

  it.each([
    ["decision", "type:preference"],
    ["error", "type:gotcha"],
    ["plan", "type:decision"],
    ["role", "type:user-context"],
    ["git", "type:workflow"],
    ["env", "type:environment"],
    ["file", "type:pattern"],
    ["mcp", "type:pattern"],
    ["skill", "type:pattern"],
    ["subagent", "type:pattern"],
    ["task", "type:workflow"],
    ["security", "type:workflow"],
    ["context", "type:user-context"],
    ["future-category", "type:pattern"],
  ])("maps passive %s events to %s without category tags", async (category, typeTag) => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "test_event", category, data: `observation ${category}`, priority: 2 }, "PostToolUse");
    edb.close();
    setupProjectDb(dir).close();

    const { res, getBody } = mockRes();
    await createPromoteEventsHandler(makeConfig(), paths)({} as any, res, JSON.stringify({ cwd: dir }));

    expect(getBody().promoted).toBe(1);
    expect(vi.mocked(deduplicateAndInsert).mock.calls[0][0].tags).toEqual([
      typeTag, "source:passive-capture", "hook:PostToolUse",
    ]);
  });

  it("correlates error→fix pairs within session", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "error_tool", category: "error", data: "Bash error: npm install", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "env_install", category: "env", data: "npm install --legacy-peer-deps", priority: 2 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    // Both events should be promoted
    expect(result.promoted).toBeGreaterThanOrEqual(2);
    expect(result.correlated).toBeGreaterThanOrEqual(1);
  });

  it.each([false, true])("never promotes repeated prompt intents (existing memories: %s)", async (seedMemories) => {
    const prompts = ["fix the bug", "investigate the failure", "review the change", "refactor the module"];
    const db = setupProjectDb(dir);
    if (seedMemories) {
      const store = new PromotedStore(db);
      for (const content of ["implement", "investigate", "review", "refactor"]) {
        store.insert({ content, projectId: projectId(dir), sessionId: "manual", tags: ["type:workflow"] });
      }
    }
    db.close();
    const edb = new EventsDb(sidecarPath);
    for (const session of ["s1", "s2", "s3"]) {
      for (const prompt of prompts) {
        const events = extractUserPromptEvents(prompt);
        expect(events).toHaveLength(1);
        expect(events[0].category).toBe("intent");
        edb.insertEvent(session, events[0], "UserPromptSubmit");
      }
    }
    edb.close();

    const { res, getBody } = mockRes();
    await createPromoteEventsHandler(makeConfig(), paths)({} as any, res, JSON.stringify({ cwd: dir }));

    expect(getBody()).toMatchObject({ promoted: 0, skipped: 12, correlated: 0, errors: 0 });
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
    const processed = new EventsDb(sidecarPath);
    try {
      expect(processed.getUnprocessed()).toEqual([]);
    } finally {
      processed.close();
    }
  });

  it.each([1, 2] as const)("skips intent events even at priority %s", async (priority) => {
    setupProjectDb(dir).close();
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "intent_implement", category: "intent", data: "implement", priority }, "UserPromptSubmit");
    edb.close();
    const { res, getBody } = mockRes();
    await createPromoteEventsHandler(makeConfig(), paths)({} as any, res, JSON.stringify({ cwd: dir }));
    expect(getBody()).toMatchObject({ promoted: 0, skipped: 1, errors: 0 });
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  it("marks all events as processed after promotion", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig(), paths);
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
    edb.insertEvent("s2", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const reinforcementSpy = vi.spyOn(EventsDb.prototype, "getPatternReinforcement");
    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(3);
    expect(deduplicateAndInsert).toHaveBeenCalledTimes(3);
    expect(reinforcementSpy).toHaveBeenCalledTimes(1);

    const call = vi.mocked(deduplicateAndInsert).mock.calls[0][0];
    expect(call.confidence).toBe(0.2);
    expect(call.newEntryConfidence).toBe(0.5);
    expect(call.tags).toContain("signal:reinforced");
    expect(call.tags).toContain("type:pattern");
  });

  it("does not bootstrap repeated priority 3 patterns from a single session burst", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(3);
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  it("is idempotent — skips already-processed events", async () => {
    const edb = new EventsDb(sidecarPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "test", priority: 1 }, "PostToolUse");
    const events = edb.getUnprocessed();
    edb.markProcessed([events[0].event_id]);
    edb.close();

    const db = setupProjectDb(dir);
    db.close();

    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    const result = getBody();
    expect(result.promoted).toBe(0);
    expect(result.message).toBe("no unprocessed events");
    expect(deduplicateAndInsert).not.toHaveBeenCalled();
  });

  function seedDecisions(count: number): void {
    const edb = new EventsDb(sidecarPath);
    for (let i = 0; i < count; i++) {
      edb.insertEvent("s1", { type: "decision", category: "decision", data: `decision ${i}`, priority: 1 }, "PostToolUse");
    }
    edb.close();
    setupProjectDb(dir).close();
  }

  it("lets the event loop run between events of a backlog", async () => {
    seedDecisions(BACKLOG);
    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();

    let otherWorkRan = false;
    setImmediate(() => { otherWorkRan = true; });
    await handler({} as any, res, JSON.stringify({ cwd: dir }));

    expect(getBody().promoted).toBe(BACKLOG);
    expect(otherWorkRan).toBe(true);
  });

  it("two concurrent runs for one project promote each event once", async () => {
    seedDecisions(BACKLOG);
    const handler = createPromoteEventsHandler(makeConfig(), paths);

    await Promise.all([
      handler({} as any, mockRes().res, JSON.stringify({ cwd: dir })),
      handler({} as any, mockRes().res, JSON.stringify({ cwd: dir })),
    ]);

    expect(deduplicateAndInsert).toHaveBeenCalledTimes(BACKLOG);
  });

  it("returns 400 when cwd is missing", async () => {
    const handler = createPromoteEventsHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({}));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody().error).toBe("cwd is required");
  });
});
