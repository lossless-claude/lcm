import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { RecallStore } from "../../src/db/recall.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-stale-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

function insertOldMemory(db: ReturnType<typeof getLcmConnection>, content: string, daysOld: number, projectId = "proj-1") {
  const store = new PromotedStore(db);
  const id = store.insert({ content, tags: ["test"], projectId, confidence: 0.8 });
  // Backdate the created_at
  const pastDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(pastDate, id);
  return id;
}

describe("PromotedStore.findStale", () => {
  it("marks old memories without surfacing as stale", () => {
    const db = makeDb();
    insertOldMemory(db, "Old untouched knowledge", 120);
    insertOldMemory(db, "Recent knowledge", 10);

    const store = new PromotedStore(db);
    const stale = store.findStale({
      staleAfterDays: 90,
      staleSurfacingWithoutUseLimit: 5,
    });

    expect(stale).toHaveLength(1);
    expect(stale[0].content).toBe("Old untouched knowledge");
    expect(stale[0].daysSinceCreated).toBeGreaterThanOrEqual(119);
  });

  it("marks old memories surfaced without use as stale", () => {
    const db = makeDb();
    const id = insertOldMemory(db, "Surfaced but never used", 120);

    // Simulate 5 surfacing events without any usage
    const recall = new RecallStore(db);
    for (let i = 0; i < 5; i++) {
      recall.logSurfacing([id], `session-${i}`);
    }

    const store = new PromotedStore(db);
    const stale = store.findStale({
      staleAfterDays: 90,
      staleSurfacingWithoutUseLimit: 5,
    });

    expect(stale).toHaveLength(1);
    expect(stale[0].surfacingCount).toBe(5);
    expect(stale[0].usageCount).toBe(0);
  });

  it("keeps old memories that have been acted upon", () => {
    const db = makeDb();
    const id = insertOldMemory(db, "Old but actively used", 120);

    // Simulate surfacing
    const recall = new RecallStore(db);
    for (let i = 0; i < 10; i++) {
      recall.logSurfacing([id], `session-${i}`);
    }

    // Simulate usage signal
    const store = new PromotedStore(db);
    store.insert({
      content: "Used old memory",
      tags: ["signal:memory_used", `memory_id:${id}`],
      projectId: "proj-1",
      confidence: 0.5,
    });

    const stale = store.findStale({
      staleAfterDays: 90,
      staleSurfacingWithoutUseLimit: 5,
    });

    expect(stale).toHaveLength(0);
  });

  it("filters by projectId", () => {
    const db = makeDb();
    insertOldMemory(db, "Project A old", 120, "proj-a");
    insertOldMemory(db, "Project B old", 120, "proj-b");

    const store = new PromotedStore(db);
    const stale = store.findStale({
      staleAfterDays: 90,
      staleSurfacingWithoutUseLimit: 5,
      projectId: "proj-a",
    });

    expect(stale).toHaveLength(1);
    expect(stale[0].content).toBe("Project A old");
  });

  it("excludes archived memories", () => {
    const db = makeDb();
    const id = insertOldMemory(db, "Old and archived", 120);
    const store = new PromotedStore(db);
    store.archive(id);

    const stale = store.findStale({
      staleAfterDays: 90,
      staleSurfacingWithoutUseLimit: 5,
    });

    expect(stale).toHaveLength(0);
  });
});

describe("PromotedStore.revive", () => {
  it("restores an archived memory to active status", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({
      content: "Archived memory to revive",
      tags: ["test"],
      projectId: "proj-1",
      confidence: 0.8,
    });

    store.archive(id);
    expect(store.search("archived memory revive", 10)).toHaveLength(0);

    store.revive(id);
    const row = store.getById(id);
    expect(row!.archived_at).toBeNull();

    const results = store.search("archived memory revive", 10);
    expect(results).toHaveLength(1);
  });
});
