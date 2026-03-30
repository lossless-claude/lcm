import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { getLcmDbFeatures } from "../../src/db/features.js";
import { upsertRedactionCounts } from "../../src/db/redaction-stats.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): DatabaseSync {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-features-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// getLcmDbFeatures
// ---------------------------------------------------------------------------

describe("getLcmDbFeatures", () => {
  it("returns a features object with fts5Available boolean", () => {
    const db = makeDb();
    const features = getLcmDbFeatures(db);
    expect(typeof features.fts5Available).toBe("boolean");
  });

  it("returns the same cached object on repeated calls", () => {
    const db = makeDb();
    const first = getLcmDbFeatures(db);
    const second = getLcmDbFeatures(db);
    expect(first).toBe(second);
  });

  it("returns independent results for different db handles", () => {
    const db1 = makeDb();
    const db2 = makeDb();
    const features1 = getLcmDbFeatures(db1);
    const features2 = getLcmDbFeatures(db2);
    // Each handle gets its own cache entry
    expect(features1).not.toBe(features2);
    // But both should agree on fts5 availability
    expect(features1.fts5Available).toBe(features2.fts5Available);
  });

  it("fts5 probe does not leave a persistent table behind", () => {
    const db = makeDb();
    getLcmDbFeatures(db);
    // The probe creates/drops a temp table; check it left no permanent tables behind
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts5%probe%'"
    ).all() as { name: string }[];
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upsertRedactionCounts
// ---------------------------------------------------------------------------

describe("upsertRedactionCounts", () => {
  it("is a no-op when all counts are zero", () => {
    const db = makeDb();
    // Should not throw and should not insert anything
    upsertRedactionCounts(db, "proj-1", { gitleaks: 0, builtIn: 0, global: 0, project: 0 });
    const rows = db.prepare(
      "SELECT * FROM redaction_stats WHERE project_id = 'proj-1'"
    ).all();
    expect(rows).toHaveLength(0);
  });

  it("inserts a row for each non-zero category", () => {
    const db = makeDb();
    upsertRedactionCounts(db, "proj-2", { gitleaks: 3, builtIn: 1, global: 0, project: 0 });
    const rows = db.prepare(
      "SELECT category, count FROM redaction_stats WHERE project_id = 'proj-2' ORDER BY category"
    ).all() as { category: string; count: number }[];
    expect(rows).toHaveLength(2);
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
    expect(byCategory["gitleaks"]).toBe(3);
    expect(byCategory["built_in"]).toBe(1);
  });

  it("accumulates counts on repeated upserts (additive)", () => {
    const db = makeDb();
    upsertRedactionCounts(db, "proj-3", { gitleaks: 0, builtIn: 5, global: 0, project: 0 });
    upsertRedactionCounts(db, "proj-3", { gitleaks: 0, builtIn: 3, global: 0, project: 0 });
    const row = db.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = 'proj-3' AND category = 'built_in'"
    ).get() as { count: number } | undefined;
    expect(row?.count).toBe(8);
  });

  it("handles all four categories in one call", () => {
    const db = makeDb();
    upsertRedactionCounts(db, "proj-4", { gitleaks: 10, builtIn: 2, global: 4, project: 7 });
    const rows = db.prepare(
      "SELECT category, count FROM redaction_stats WHERE project_id = 'proj-4' ORDER BY category"
    ).all() as { category: string; count: number }[];
    expect(rows).toHaveLength(4);
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
    expect(byCategory["gitleaks"]).toBe(10);
    expect(byCategory["built_in"]).toBe(2);
    expect(byCategory["global"]).toBe(4);
    expect(byCategory["project"]).toBe(7);
  });

  it("keeps counts isolated per project_id", () => {
    const db = makeDb();
    upsertRedactionCounts(db, "proj-A", { gitleaks: 5, builtIn: 0, global: 0, project: 0 });
    upsertRedactionCounts(db, "proj-B", { gitleaks: 9, builtIn: 0, global: 0, project: 0 });
    const rowA = db.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = 'proj-A' AND category = 'gitleaks'"
    ).get() as { count: number } | undefined;
    const rowB = db.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = 'proj-B' AND category = 'gitleaks'"
    ).get() as { count: number } | undefined;
    expect(rowA?.count).toBe(5);
    expect(rowB?.count).toBe(9);
  });

  it("only inserts the global category when only global is non-zero", () => {
    const db = makeDb();
    upsertRedactionCounts(db, "proj-5", { gitleaks: 0, builtIn: 0, global: 2, project: 0 });
    const rows = db.prepare(
      "SELECT category FROM redaction_stats WHERE project_id = 'proj-5'"
    ).all() as { category: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("global");
  });
});
