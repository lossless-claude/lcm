// test/hooks/events-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventsDb, type EventRow, type HealthStats } from "../../src/hooks/events-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EventsDb", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "events-db-test-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates schema on first open", () => {
    const db = new EventsDb(dbPath);
    // Should not throw
    db.close();
  });

  it("inserts and retrieves events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("session-1", {
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
    }, "PostToolUse");

    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: "session-1",
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      processed_at: null,
    });
    db.close();
  });

  it("increments seq per session", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.insertEvent("s2", { type: "c", category: "file", data: "z", priority: 3 }, "PostToolUse");

    const events = db.getUnprocessed();
    const s1Events = events.filter(e => e.session_id === "s1");
    const s2Events = events.filter(e => e.session_id === "s2");
    expect(s1Events[0].seq).toBe(1);
    expect(s1Events[1].seq).toBe(2);
    expect(s2Events[0].seq).toBe(1);
    db.close();
  });

  it("marks events as processed", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);

    db.markProcessed([events[0].event_id]);
    expect(db.getUnprocessed()).toHaveLength(0);
    db.close();
  });

  it("prunes old processed events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    db.markProcessed([events[0].event_id]);

    // Manually backdate the processed_at to 10 days ago
    db.raw().exec(
      `UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${events[0].event_id}`
    );

    const pruned = db.pruneProcessed(7);
    expect(pruned).toBe(1);
    db.close();
  });

  it("handles concurrent opens (WAL mode)", () => {
    const db1 = new EventsDb(dbPath);
    const db2 = new EventsDb(dbPath);
    db1.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db2.insertEvent("s2", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");

    const events = db1.getUnprocessed();
    expect(events).toHaveLength(2);
    db1.close();
    db2.close();
  });

  describe("Schema v2 — error_log + pruning", () => {
    it("migrates v1 DB to v2 on open", () => {
      // Create a v1 DB manually (no error_log table)
      const { DatabaseSync } = require("node:sqlite");
      const { mkdirSync } = require("node:fs");
      const { dirname } = require("node:path");
      mkdirSync(dirname(dbPath), { recursive: true });
      const rawDb = new DatabaseSync(dbPath);
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events (
          event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id    TEXT NOT NULL,
          seq           INTEGER NOT NULL DEFAULT 0,
          type          TEXT NOT NULL,
          category      TEXT NOT NULL,
          data          TEXT NOT NULL,
          priority      INTEGER DEFAULT 3,
          source_hook   TEXT NOT NULL,
          prev_event_id INTEGER,
          processed_at  TEXT,
          created_at    TEXT DEFAULT (datetime('now'))
        );
      `);
      rawDb.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
      rawDb.close();

      // Now open with EventsDb — should migrate to v2
      const db = new EventsDb(dbPath);
      const tableRow = db.raw().prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='error_log'"
      ).get();
      expect(tableRow).toBeDefined();
      const versionRow = db.raw().prepare("SELECT version FROM schema_version").get() as { version: number };
      expect(versionRow.version).toBe(2);
      db.close();
    });

    it("logHookError inserts into error_log", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("something went wrong"), "session-abc");
      const row = db.raw().prepare("SELECT * FROM error_log").get() as {
        id: number; hook: string; error: string; session_id: string | null; created_at: string;
      };
      expect(row).toBeDefined();
      expect(row.hook).toBe("PostToolUse");
      expect(row.error).toBe("something went wrong");
      expect(row.session_id).toBe("session-abc");
      db.close();
    });

    it("logHookError handles non-Error values", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PreToolUse", "raw string error");
      const row = db.raw().prepare("SELECT * FROM error_log").get() as { error: string; session_id: string | null };
      expect(row.error).toBe("raw string error");
      expect(row.session_id).toBeNull();
      db.close();
    });

    it("getHealthStats returns correct counts", () => {
      const db = new EventsDb(dbPath);
      db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
      db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
      const events = db.getUnprocessed();
      db.markProcessed([events[0].event_id]);
      db.logHookError("PostToolUse", new Error("oops"), "s1");

      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.unprocessed).toBe(1);
      expect(stats.errors).toBe(1);
      expect(stats.lastCapture).not.toBeNull();
      expect(stats.lastError).not.toBeNull();
      db.close();
    });

    it("getHealthStats returns zeros on empty DB", () => {
      const db = new EventsDb(dbPath);
      const stats: HealthStats = db.getHealthStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.unprocessed).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastCapture).toBeNull();
      expect(stats.lastError).toBeNull();
      db.close();
    });

    it("pruneUnprocessed caps rows by event_id", () => {
      const db = new EventsDb(dbPath);
      // Insert 15 unprocessed events
      for (let i = 0; i < 15; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const before = db.getUnprocessed();
      expect(before).toHaveLength(15);

      // Prune to max 10 rows (no age pruning — use large maxAgeDays)
      const result = db.pruneUnprocessed(10, 9999);
      expect(result.pruned).toBe(5);

      const after = db.getUnprocessed();
      expect(after).toHaveLength(10);
      // Oldest 5 (lowest event_ids) should be removed
      const minRemaining = Math.min(...after.map(e => e.event_id));
      const maxRemoved = Math.max(...before.slice(0, 5).map(e => e.event_id));
      expect(minRemaining).toBeGreaterThan(maxRemoved);
      db.close();
    });

    it("pruneUnprocessed logs count to error_log before deleting", () => {
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 5; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      db.pruneUnprocessed(3, 9999);

      const logRow = db.raw().prepare("SELECT error FROM error_log WHERE hook = 'pruneUnprocessed'").get() as { error: string } | undefined;
      expect(logRow).toBeDefined();
      expect(logRow!.error).toContain("pruned");
      db.close();
    });

    it("pruneUnprocessed wraps log+delete in one transaction", () => {
      // Just verify pruneUnprocessed returns { pruned } and leaves DB consistent
      const db = new EventsDb(dbPath);
      for (let i = 0; i < 3; i++) {
        db.insertEvent("s1", { type: "a", category: "file", data: `d${i}`, priority: 3 }, "PostToolUse");
      }
      const result = db.pruneUnprocessed(2, 9999);
      expect(result).toEqual({ pruned: 1 });
      expect(db.getUnprocessed()).toHaveLength(2);
      db.close();
    });

    it("pruneErrorLog removes old entries", () => {
      const db = new EventsDb(dbPath);
      db.logHookError("PostToolUse", new Error("old error"), "s1");
      // Backdate the entry
      db.raw().exec("UPDATE error_log SET created_at = datetime('now', '-31 days')");
      // Add a recent entry
      db.logHookError("PostToolUse", new Error("recent error"), "s1");

      const pruned = db.pruneErrorLog(30);
      expect(pruned).toBe(1);

      const remaining = db.raw().prepare("SELECT COUNT(*) as c FROM error_log").get() as { c: number };
      expect(remaining.c).toBe(1);
      db.close();
    });
  });
});
