// test/hooks/hook-errors.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock eventsDbPath to use temp dir.
// Paths under /dev/null/... are kept as-is so DB creation fails and triggers the circuit breaker.
let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", async () => {
  const { createHash } = await import("node:crypto");
  return {
    eventsDbPath: (cwd: string) => {
      if (cwd.startsWith("/dev/null/")) return join(cwd, "events.db");
      const hash = createHash("sha256").update(cwd).digest("hex");
      return join(mockEventsDir, `${hash}.db`);
    },
  };
});

// Import after mocks
import { safeLogError, _resetCircuitBreaker } from "../../src/hooks/hook-errors.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";

describe("safeLogError", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hook-errors-test-"));
    mockEventsDir = join(tempDir, "events");
    process.env.LCM_LOG_PATH = join(tempDir, "events.log");
    _resetCircuitBreaker();
  });

  afterEach(() => {
    delete process.env.LCM_LOG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Layer 1: writes to sidecar DB when cwd is valid", () => {
    const cwd = join(tempDir, "project");
    safeLogError("PostToolUse", new Error("test error"), { cwd, sessionId: "s1" });

    const db = new EventsDb(eventsDbPath(cwd));
    const rows = db.raw().prepare("SELECT * FROM error_log").all() as Array<{
      hook: string; error: string; session_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe("PostToolUse");
    expect(rows[0].error).toBe("test error");
    db.close();
  });

  it("Layer 1: skips DB when cwd is undefined, falls to Layer 2", () => {
    safeLogError("PostToolUse", new Error("no cwd"), {});
    const logPath = join(tempDir, "events.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("no cwd");
  });

  it("Layer 2: writes to flat file when DB fails", () => {
    const cwd = "/dev/null/impossible";
    safeLogError("PostToolUse", new Error("db fail"), { cwd, sessionId: "s1" });

    const testLogPath = join(tempDir, "events.log");
    if (existsSync(testLogPath)) {
      const content = readFileSync(testLogPath, "utf-8");
      expect(content).toContain("db fail");
      expect(content).toContain("PostToolUse");
      expect(content).toContain("/dev/null/impossible");
    }
  });

  it("circuit breaker: skips DB after first failure", () => {
    const badCwd = "/dev/null/impossible";
    safeLogError("PostToolUse", new Error("first"), { cwd: badCwd });

    const goodCwd = join(tempDir, "project2");
    safeLogError("PostToolUse", new Error("second"), { cwd: goodCwd });

    // Good CWD should NOT have a DB entry because circuit is open
    const dbPath = eventsDbPath(goodCwd);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("Layer 3: swallows silently when both DB and file fail", () => {
    expect(() => {
      safeLogError("PostToolUse", new Error("total fail"), {});
    }).not.toThrow();
  });
});
