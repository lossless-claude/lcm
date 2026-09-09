// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
}));

import { collectEventStats, collectDetailedEventStats } from "../../src/db/events-stats.js";
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
    expect(stats.scanned).toBe(2);
    expect(stats.total).toBe(2);
    const detailed = collectDetailedEventStats();
    expect(detailed).toMatchObject(stats);
    expect(detailed.projects).toHaveLength(2);
    expect(detailed.recentErrors).toEqual([expect.objectContaining({ hook: "PostToolUse", error: "err1" })]);
  });

  it.each([collectEventStats, collectDetailedEventStats])("reads legacy sidecars without changing their schema or bytes (%s)", (collect) => {
    const path = join(tempDir, "legacy.db");
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE events (event_id INTEGER PRIMARY KEY, created_at TEXT, processed_at TEXT);
      CREATE TABLE error_log (id INTEGER PRIMARY KEY, created_at TEXT, hook TEXT, error TEXT);
      INSERT INTO events VALUES (1, datetime('now'), NULL);
      INSERT INTO error_log VALUES (1, datetime('now'), 'PostToolUse', 'legacy error');
    `);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const before = readFileSync(path);
    expect(collect()).toMatchObject({ captured: 1, unprocessed: 1, errors: 1, scanned: 1, total: 1 });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(tempDir)).toEqual(["legacy.db"]);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
      expect(inspect.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    } finally { inspect.close(); }
  });

  it.each([collectEventStats, collectDetailedEventStats])("reads v1 sidecars without error_log or mutations (%s)", (collect) => {
    const path = join(tempDir, "v1.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1);
      CREATE TABLE events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        data TEXT NOT NULL,
        priority INTEGER DEFAULT 3,
        source_hook TEXT NOT NULL,
        prev_event_id INTEGER,
        processed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO events (session_id, type, category, data, source_hook, created_at)
        VALUES ('s1', 'file', 'pattern', 'file.ts', 'PostToolUse', '2026-01-02 03:04:05');
      INSERT INTO events (session_id, type, category, data, source_hook, created_at, processed_at)
        VALUES ('s1', 'file', 'pattern', 'other.ts', 'PostToolUse', '2026-01-01 03:04:05', '2026-01-02');
    `);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    db.close();
    const before = readFileSync(path);
    const stats = collect();
    expect(stats).toMatchObject({
      captured: 2, unprocessed: 1, errors: 0, lastCapture: "2026-01-02 03:04:05", scanned: 1, total: 1,
    });
    if ("projects" in stats) {
      expect(stats.projects).toEqual([{
        file: "v1.db", captured: 2, unprocessed: 1, lastCapture: "2026-01-02 03:04:05",
      }]);
      expect(stats.recentErrors).toEqual([]);
    }
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(tempDir)).toEqual(["v1.db"]);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: 1 });
      expect(inspect.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    } finally { inspect.close(); }
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
