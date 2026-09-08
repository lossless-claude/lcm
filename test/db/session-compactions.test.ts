// test/db/session-compactions.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import {
  markSessionCompacted,
  wasSessionJustCompacted,
  JUST_COMPACTED_TTL_MS,
} from "../../src/db/session-compactions.js";

describe("session compaction marks", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-compactions-"));
    db = new DatabaseSync(join(dir, "lcm.db"));
    runLcmMigrations(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is unmarked before any compaction", () => {
    expect(wasSessionJustCompacted(db, "s1")).toBe(false);
  });

  it("marks a session and reads it back", () => {
    markSessionCompacted(db, "s1");
    expect(wasSessionJustCompacted(db, "s1")).toBe(true);
    expect(wasSessionJustCompacted(db, "s2")).toBe(false);
  });

  it("stops matching once the window has passed", () => {
    const now = Date.now();
    markSessionCompacted(db, "s1", now);
    expect(wasSessionJustCompacted(db, "s1", now + JUST_COMPACTED_TTL_MS - 1)).toBe(true);
    expect(wasSessionJustCompacted(db, "s1", now + JUST_COMPACTED_TTL_MS)).toBe(false);
  });

  it("survives reopening the database, unlike the daemon's memory", () => {
    markSessionCompacted(db, "s1");
    db.close();
    db = new DatabaseSync(join(dir, "lcm.db"));
    expect(wasSessionJustCompacted(db, "s1")).toBe(true);
  });

  it("re-marking the same session moves its window", () => {
    const now = Date.now();
    markSessionCompacted(db, "s1", now);
    markSessionCompacted(db, "s1", now + JUST_COMPACTED_TTL_MS * 2);
    expect(wasSessionJustCompacted(db, "s1", now + JUST_COMPACTED_TTL_MS * 2 + 1)).toBe(true);
  });

  it("sweeps marks that can no longer match", () => {
    const now = Date.now();
    markSessionCompacted(db, "old", now);
    markSessionCompacted(db, "new", now + JUST_COMPACTED_TTL_MS * 2);
    const rows = db.prepare("SELECT session_id FROM session_compactions").all() as { session_id: string }[];
    expect(rows.map(r => r.session_id)).toEqual(["new"]);
  });
});
