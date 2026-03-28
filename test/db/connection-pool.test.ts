// test/db/connection-pool.test.ts
/**
 * Tests for EventsDb connection pooling behaviour (issue #131).
 *
 * Core invariants:
 *  - Multiple EventsDb instances for the same path share ONE underlying DatabaseSync
 *  - Migration runs exactly once per connection lifetime (not once per EventsDb instance)
 *  - The underlying connection is only closed when the last holder calls close()
 *  - After full eviction, the migration cache is cleared so the next open re-migrates
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventsDb, _resetMigratedPathsForTesting } from "../../src/hooks/events-db.js";
import { getLcmConnection, closeLcmConnection, isLcmConnectionOpen } from "../../src/db/connection.js";

describe("EventsDb connection pooling (issue #131)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lcm-pool-test-"));
    dbPath = join(tempDir, "events.db");
    // Reset migration cache and pool state so tests are independent.
    _resetMigratedPathsForTesting();
    closeLcmConnection(); // clear all pooled connections
  });

  afterEach(() => {
    // Always drain the pool before removing temp files.
    closeLcmConnection();
    _resetMigratedPathsForTesting();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("two EventsDb instances for the same path share the same DatabaseSync handle", () => {
    const a = new EventsDb(dbPath);
    const b = new EventsDb(dbPath);

    // Both instances expose the same underlying db object (identity equality).
    expect(a.raw()).toBe(b.raw());

    b.close();
    a.close();
  });

  it("connection stays open while a second holder exists", () => {
    const a = new EventsDb(dbPath);
    const b = new EventsDb(dbPath);

    b.close();
    // Pool still has a ref (from a), so the connection should still be alive.
    expect(isLcmConnectionOpen(dbPath)).toBe(true);

    // a should still be usable after b closed.
    expect(() => a.insertEvent("s1", { type: "file_read", category: "context", data: "{}", priority: 3 }, "PostToolUse")).not.toThrow();

    a.close();
    // Now refs = 0 → connection evicted.
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("pool is evicted after the last EventsDb closes", () => {
    const db = new EventsDb(dbPath);
    expect(isLcmConnectionOpen(dbPath)).toBe(true);

    db.close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });

  it("migration runs only once per connection lifetime even with multiple EventsDb instances", () => {
    // Open the first EventsDb which triggers migration (schema creation / schema_version checks).
    // Subsequent opens for the same path should not re-run the migration on the same connection.
    const a = new EventsDb(dbPath);
    const rawDb = a.raw();

    // Patch exec to detect re-migration: if schema creation SQL runs again, that's a bug.
    const execCalls: string[] = [];
    const origExec = rawDb.exec.bind(rawDb);
    rawDb.exec = (sql: string) => {
      execCalls.push(sql);
      return origExec(sql);
    };

    // Second open: migration should NOT run again (path is in _migratedPaths).
    const b = new EventsDb(dbPath);

    // No CREATE TABLE calls should have happened from the second constructor.
    const createTableCalls = execCalls.filter(s => s.includes("CREATE TABLE"));
    expect(createTableCalls).toHaveLength(0);

    b.close();
    a.close();
  });

  it("migration re-runs after connection is fully evicted and re-opened", () => {
    // First lifetime: open and fully close.
    const first = new EventsDb(dbPath);
    first.close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);

    // Second lifetime: should open successfully (migration runs again on fresh DB).
    // The DB already has the schema so migration is a no-op, but it must not throw.
    const second = new EventsDb(dbPath);
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
    expect(() => second.insertEvent("s2", { type: "file_read", category: "context", data: "{}", priority: 3 }, "PostToolUse")).not.toThrow();
    second.close();
  });

  it("different db paths get independent connections", () => {
    const dbPath2 = join(tempDir, "events2.db");
    const a = new EventsDb(dbPath);
    const b = new EventsDb(dbPath2);

    expect(a.raw()).not.toBe(b.raw());
    expect(isLcmConnectionOpen(dbPath)).toBe(true);
    expect(isLcmConnectionOpen(dbPath2)).toBe(true);

    a.close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
    expect(isLcmConnectionOpen(dbPath2)).toBe(true);

    b.close();
    expect(isLcmConnectionOpen(dbPath2)).toBe(false);
  });

  it("pool ref-counting: N opens require N closes before eviction", () => {
    const instances = Array.from({ length: 5 }, () => new EventsDb(dbPath));

    for (let i = 0; i < 4; i++) {
      instances[i].close();
      expect(isLcmConnectionOpen(dbPath)).toBe(true);
    }

    instances[4].close();
    expect(isLcmConnectionOpen(dbPath)).toBe(false);
  });
});
