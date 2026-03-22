import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-promoted-store-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("PromotedStore", () => {
  it("stores and retrieves a memory", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    const id = store.insert({
      content: "We decided to use React for the frontend",
      tags: ["decision", "frontend"],
      projectId: "proj-1",
      sessionId: "sess-1",
      depth: 1,
      confidence: 0.8,
    });

    expect(id).toBeTruthy();
    const row = store.getById(id);
    expect(row).not.toBeNull();
    expect(row!.content).toBe("We decided to use React for the frontend");
    expect(JSON.parse(row!.tags)).toContain("decision");
  });

  it("searches via FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "React is the chosen framework", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database uses PostgreSQL", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Unrelated cooking recipe", tags: ["other"], projectId: "p1" });

    const results = store.search("React framework", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("React");
  });

  it("filters by tags", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({ content: "React decision", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "React note", tags: ["note"], projectId: "p1" });

    const results = store.search("React", 10, ["decision"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("React decision");
  });

  it("returns empty array for no matches", () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    const results = store.search("nonexistent", 10);
    expect(results).toEqual([]);
  });

  it("archive() soft-deletes entry and removes from FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "React is the framework", tags: ["decision"], projectId: "p1" });

    store.archive(id);

    const row = store.getById(id);
    expect(row!.archived_at).toBeTruthy();

    // Should not appear in search results
    const results = store.search("React framework", 10);
    expect(results.find((r) => r.id === id)).toBeUndefined();
  });

  it("deleteById() removes entry and FTS5 row", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Delete me", tags: [], projectId: "p1" });

    store.deleteById(id);
    expect(store.getById(id)).toBeNull();
  });

  it("update() changes content and re-syncs FTS5", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const id = store.insert({ content: "Old content about React", tags: ["decision"], projectId: "p1", confidence: 0.9 });

    store.update(id, { content: "New content about Vue", confidence: 0.7 });

    const row = store.getById(id);
    expect(row!.content).toBe("New content about Vue");
    expect(row!.confidence).toBe(0.7);

    // FTS5 should find new content
    const results = store.search("Vue", 10);
    expect(results.length).toBe(1);

    // FTS5 should NOT find old content
    const oldResults = store.search("React", 10);
    expect(oldResults.length).toBe(0);
  });

  it("search() excludes archived entries", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    store.insert({ content: "Active React decision", tags: ["decision"], projectId: "p1" });
    const archivedId = store.insert({ content: "Archived React memory", tags: ["decision"], projectId: "p1" });
    store.archive(archivedId);

    const results = store.search("React", 10);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("Active");
  });
});
