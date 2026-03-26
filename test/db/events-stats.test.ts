// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
}));

import { collectEventStats } from "../../src/db/events-stats.js";
import { EventsDb } from "../../src/hooks/events-db.js";

describe("collectEventStats", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "events-stats-test-"));
    mockEventsDir = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns zeros when no sidecar DBs exist", () => {
    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.unprocessed).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastCapture).toBeNull();
  });

  it("aggregates across multiple sidecar DBs", () => {
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.insertEvent("s1", { type: "file", category: "pattern", data: "f1", priority: 3 }, "PostToolUse");
    db1.logHookError("PostToolUse", new Error("err1"));
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "git", category: "workflow", data: "g1", priority: 2 }, "PostToolUse");
    db2.close();

    const stats = collectEventStats();
    expect(stats.captured).toBe(3);
    expect(stats.unprocessed).toBe(3);
    expect(stats.errors).toBe(1);
  });

  it("skips non-.db files in events directory", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "not-a-db.txt"), "hello");

    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("handles corrupt DB gracefully", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("respects timeout budget", () => {
    const stats = collectEventStats(0);
    expect(stats.captured).toBe(0);
  });
});
