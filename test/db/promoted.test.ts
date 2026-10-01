import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it.each(['["type:decision"]', "type:decision", ["type:decision", 7]])(
    "rejects non-array or non-string tags before insert: %j", (tags) => {
      const store = new PromotedStore(makeDb());
      expect(() => store.insert({ content: "Invalid tags", projectId: "p1", tags: tags as string[] }))
        .toThrow("tags must be an array of strings");
      expect(store.count()).toBe(0);
    },
  );

  it.each([false, true])("rejects serialized tags before any update (content update: %s)", (changeContent) => {
    const store = new PromotedStore(makeDb());
    const id = store.insert({ content: "Original observation", tags: ["type:decision"], projectId: "p1" });
    const before = store.getById(id);
    expect(() => store.update(id, {
      tags: '["type:pattern"]' as unknown as string[], confidence: 0.2,
      ...(changeContent ? { content: "Replacement observation" } : {}),
    })).toThrow("tags must be an array of strings");
    expect(store.getById(id)).toEqual(before);
    expect(store.search("Original observation", 10, ["type:decision"]).map((row) => row.id)).toEqual([id]);
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

  it("search() excludes signal-tagged records (use and vote reports)", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "React is the chosen framework", tags: ["decision"], projectId: "p1" });
    store.insert({
      content: "Acted on memory — used it to pick React",
      tags: ["signal:memory_used", `memory_id:${memoryId}`],
      projectId: "p1",
    });
    store.insert({
      content: "Verified React is still the framework",
      tags: ["signal:memory_vote", "vote:+1", `memory_id:${memoryId}`],
      projectId: "p1",
    });

    const results = store.search("React", 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("React is the chosen framework");
  });

  it("getVoteCounts() tallies +1/-1 per memory and lists -1 reasons", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "React is the chosen framework", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "still true", tags: ["signal:memory_vote", "vote:+1", `memory_id:${memoryId}`], projectId: "p1" });
    store.insert({ content: "still true again", tags: ["signal:memory_vote", "vote:+1", `memory_id:${memoryId}`], projectId: "p1" });
    const objectionId = store.insert({
      content: "no longer true: we moved to Vue",
      tags: ["signal:memory_vote", "vote:-1", `memory_id:${memoryId}`],
      projectId: "p1",
    });

    const counts = store.getVoteCounts().get(memoryId);
    expect(counts).toBeTruthy();
    expect(counts!.plusOne).toBe(2);
    expect(counts!.minusOne).toBe(1);
    expect(counts!.objections).toEqual([{ voteId: objectionId, reason: "no longer true: we moved to Vue", sessionId: null }]);
  });

  it("getVoteCounts() excludes archived vote rows (the dismissal mechanism)", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "React is the chosen framework", tags: ["decision"], projectId: "p1" });
    const objectionId = store.insert({
      content: "no longer true",
      tags: ["signal:memory_vote", "vote:-1", `memory_id:${memoryId}`],
      projectId: "p1",
    });
    store.archive(objectionId);

    expect(store.getVoteCounts().get(memoryId)).toBeUndefined();
  });

  // With the project row as the outer loop, SQLite re-runs the MATCH once per promoted row of
  // the project, re-seeking every term each time: a project-scoped dedup query then costs rows
  // times terms, all of it synchronous on the daemon's event loop.
  it("drives a project-scoped search from the full-text index, not from the project's rows", () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    store.insert({ content: "Decided to use PostgreSQL for the database", tags: ["decision"], projectId: "p1" });

    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("promoted_fts MATCH")) statements.push(sql);
      return prepare(sql);
    });
    expect(store.search("postgresql database", 10, undefined, "p1")).toHaveLength(1);
    spy.mockRestore();

    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`).all('"postgresql"', "p1", 10) as Array<{ detail: string }>)
      .map((row) => row.detail);
    expect(plan[0]).toMatch(/^SCAN fts VIRTUAL TABLE/);
  });
});
