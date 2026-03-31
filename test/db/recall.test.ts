import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { RecallStore } from "../../src/db/recall.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): DatabaseSync {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-recall-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("RecallStore.logSurfacing", () => {
  it("records surfacing events for given memory IDs", () => {
    const db = makeDb();
    const store = new RecallStore(db);
    store.logSurfacing(["id-1", "id-2"], "sess-a");

    const rows = db.prepare("SELECT memory_id, session_id FROM recall_surfacing ORDER BY id").all() as Array<{ memory_id: string; session_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].memory_id).toBe("id-1");
    expect(rows[0].session_id).toBe("sess-a");
    expect(rows[1].memory_id).toBe("id-2");
  });

  it("handles null session_id", () => {
    const db = makeDb();
    const store = new RecallStore(db);
    store.logSurfacing(["id-x"], null);

    const row = db.prepare("SELECT session_id FROM recall_surfacing").get() as { session_id: string | null };
    expect(row.session_id).toBeNull();
  });

  it("is a no-op for empty array", () => {
    const db = makeDb();
    const store = new RecallStore(db);
    store.logSurfacing([], "sess-a");

    const count = (db.prepare("SELECT COUNT(*) as c FROM recall_surfacing").get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe("RecallStore.getStats", () => {
  it("returns zeros when no data exists", () => {
    const db = makeDb();
    const store = new RecallStore(db);
    const stats = store.getStats();

    expect(stats.memoriesSurfaced).toBe(0);
    expect(stats.memoriesActedUpon).toBe(0);
    expect(stats.recallPrecision).toBeNull();
    expect(stats.topRecalled).toEqual([]);
  });

  it("counts distinct surfaced memory IDs", () => {
    const db = makeDb();
    const store = new RecallStore(db);
    // Surface same memory twice
    store.logSurfacing(["id-1", "id-2"], "sess-a");
    store.logSurfacing(["id-1"], "sess-b");

    const stats = store.getStats();
    expect(stats.memoriesSurfaced).toBe(2); // distinct: id-1, id-2
  });

  it("counts acted-upon memories from signal:memory_used entries", () => {
    const db = makeDb();
    const promoted = new PromotedStore(db);
    const recall = new RecallStore(db);

    // Insert a base memory
    const memId = promoted.insert({ content: "Use PostgreSQL", tags: ["decision"], projectId: "p1" });

    // Surface it
    recall.logSurfacing([memId], "sess-a");

    // Record act
    promoted.insert({
      content: "Acted on memory — confirmed PostgreSQL choice",
      tags: ["signal:memory_used", `memory_id:${memId}`],
      projectId: "p1",
      sessionId: "sess-a",
    });

    const stats = recall.getStats();
    expect(stats.memoriesActedUpon).toBe(1);
    expect(stats.memoriesSurfaced).toBe(1);
    expect(stats.recallPrecision).toBe(100);
    expect(stats.topRecalled).toHaveLength(1);
    expect(stats.topRecalled[0].id).toBe(memId);
    expect(stats.topRecalled[0].actCount).toBe(1);
    expect(stats.topRecalled[0].content).toBe("Use PostgreSQL");
  });

  it("computes precision as acted/surfaced percentage", () => {
    const db = makeDb();
    const promoted = new PromotedStore(db);
    const recall = new RecallStore(db);

    const id1 = promoted.insert({ content: "Decision A", tags: [], projectId: "p1" });
    const id2 = promoted.insert({ content: "Decision B", tags: [], projectId: "p1" });

    recall.logSurfacing([id1, id2], "sess-a");

    // Only act on id1
    promoted.insert({
      content: "Acted on A",
      tags: ["signal:memory_used", `memory_id:${id1}`],
      projectId: "p1",
    });

    const stats = recall.getStats();
    expect(stats.memoriesSurfaced).toBe(2);
    expect(stats.memoriesActedUpon).toBe(1);
    expect(stats.recallPrecision).toBeCloseTo(50, 1);
  });

  it("returns top 5 recalled sorted by act count", () => {
    const db = makeDb();
    const promoted = new PromotedStore(db);
    const recall = new RecallStore(db);

    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(promoted.insert({ content: `Memory ${i}`, tags: [], projectId: "p1" }));
    }
    recall.logSurfacing(ids, "sess");

    // Act on each memory a different number of times
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j <= i; j++) {
        promoted.insert({
          content: `Act on ${i} round ${j}`,
          tags: ["signal:memory_used", `memory_id:${ids[i]}`],
          projectId: "p1",
        });
      }
    }

    const stats = recall.getStats();
    expect(stats.topRecalled).toHaveLength(5);
    // Highest act count first (id[6] acted 7 times)
    expect(stats.topRecalled[0].id).toBe(ids[6]);
    expect(stats.topRecalled[0].actCount).toBe(7);
  });

  it("recallPrecision is null when no memories surfaced", () => {
    const db = makeDb();
    const recall = new RecallStore(db);
    const stats = recall.getStats();
    expect(stats.recallPrecision).toBeNull();
  });
});

describe("RecallStore.getFeedback", () => {
  it("aggregates usage counts and surfacing metadata for requested memories", () => {
    const db = makeDb();
    const promoted = new PromotedStore(db);
    const recall = new RecallStore(db);

    const usedId = promoted.insert({ content: "Use SQLite", tags: ["decision"], projectId: "p1" });
    const unusedId = promoted.insert({ content: "Use Bun", tags: ["decision"], projectId: "p1" });

    recall.logSurfacing([usedId, usedId, unusedId], "sess-a");
    promoted.insert({
      content: "Acted on SQLite choice",
      tags: ["signal:memory_used", `memory_id:${usedId}`],
      projectId: "p1",
    });
    promoted.insert({
      content: "Acted on SQLite choice again",
      tags: ["signal:memory_used", `memory_id:${usedId}`],
      projectId: "p1",
    });

    const feedback = recall.getFeedback([usedId, unusedId]);

    expect(feedback.get(usedId)).toMatchObject({
      usageCount: 2,
      surfacingCount: 2,
    });
    expect(feedback.get(usedId)?.lastSurfacedAt).toEqual(expect.any(String));
    expect(feedback.get(unusedId)).toMatchObject({
      usageCount: 0,
      surfacingCount: 1,
    });
  });

  it("returns zeroed feedback for unknown memory ids", () => {
    const db = makeDb();
    const recall = new RecallStore(db);

    const feedback = recall.getFeedback(["missing-id"]);

    expect(feedback.get("missing-id")).toEqual({
      usageCount: 0,
      surfacingCount: 0,
      lastSurfacedAt: null,
    });
  });

  it("treats underscores in memory_id tags as literal characters", () => {
    const db = makeDb();
    const recall = new RecallStore(db);

    db.prepare(
      `INSERT INTO promoted (id, content, tags, source_summary_id, project_id, session_id, depth, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "signal-a",
      "Used memory with underscore",
      JSON.stringify(["signal:memory_used", "memory_id:memory_1"]),
      null,
      "p1",
      null,
      0,
      1,
    );
    db.prepare(
      `INSERT INTO promoted (id, content, tags, source_summary_id, project_id, session_id, depth, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "signal-b",
      "Used similar memory",
      JSON.stringify(["signal:memory_used", "memory_id:memoryA1"]),
      null,
      "p1",
      null,
      0,
      1,
    );

    const feedback = recall.getFeedback(["memory_1"]);

    expect(feedback.get("memory_1")).toEqual({
      usageCount: 1,
      surfacingCount: 0,
      lastSurfacedAt: null,
    });
  });
});
