import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // A pre-backfill schema: seed legacy encodings without going through today's writer.
  db.exec(`
    CREATE TABLE promoted (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
      source_summary_id TEXT, project_id TEXT NOT NULL, session_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT
    );
    CREATE VIRTUAL TABLE promoted_fts USING fts5(content, tags, tokenize='porter unicode61');
  `);
});

afterEach(() => db.close());

function seed(tags: string, archived = false): void {
  db.prepare(`INSERT INTO promoted (id, content, tags, project_id, session_id, confidence, created_at, archived_at)
    VALUES ('memory', 'Passive observation', ?, 'project', 'session', 0.3, '2025-01-01 00:00:00', ?)`)
    .run(tags, archived ? "2025-02-01 00:00:00" : null);
  if (!archived) db.prepare("INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, content, tags FROM promoted").run();
}

function migrate(fts5Available = true): void {
  runLcmMigrations(db, { fts5Available });
}

describe("promoted tag migration", () => {
  it.each([
    ["decision", "type:preference"], ["error", "type:gotcha"], ["plan", "type:decision"],
    ["role", "type:user-context"], ["env", "type:environment"], ["git", "type:workflow"],
    ["file", "type:pattern"], ["mcp", "type:pattern"], ["skill", "type:pattern"],
    ["subagent", "type:pattern"], ["intent", "type:workflow"], ["task", "type:workflow"],
    ["security", "type:workflow"], ["context", "type:user-context"], ["future-category", "type:pattern"],
  ])("backfills passive %s as %s and synchronizes search", (category, typeTag) => {
    seed(JSON.stringify([`category:${category}`, "source:passive-capture", "hook:PostToolUse"]));
    const before = new PromotedStore(db).getById("memory")!;
    migrate();
    const store = new PromotedStore(db);
    expect(store.getById("memory")).toEqual({ ...before,
      tags: JSON.stringify(["source:passive-capture", "hook:PostToolUse", typeTag]),
    });
    expect(store.search("Passive observation", 10, [typeTag]).map((row) => row.id)).toEqual(["memory"]);
    expect(db.prepare("SELECT tags FROM promoted_fts").get()).toEqual({ tags: store.getById("memory")!.tags });
    expect(db.prepare("SELECT rowid FROM promoted_fts WHERE promoted_fts MATCH ?").all(`tags : "${typeTag}"`)).toHaveLength(1);
    migrate();
    expect(store.getById("memory")!.tags).toBe(JSON.stringify(["source:passive-capture", "hook:PostToolUse", typeTag]));
    expect(db.prepare("SELECT rowid FROM promoted_fts").all()).toHaveLength(1);
  });

  it.each([
    [JSON.stringify(JSON.stringify(["type:decision", "project:lcm"])), ["type:decision", "project:lcm"]],
    [JSON.stringify("type:decision"), ["type:decision"]],
    [JSON.stringify(["category:task", "project:lcm"]), ["category:task", "project:lcm"]],
  ])("normalizes string tags without retyping explicit memories: %s", (stored, tags) => {
    seed(stored);
    migrate();
    expect(JSON.parse(new PromotedStore(db).getById("memory")!.tags)).toEqual(tags);
    expect(new PromotedStore(db).search("Passive", 10, tags).map((row) => row.id)).toEqual(["memory"]);
  });

  it("normalizes encoded passive arrays and preserves an existing solution type", () => {
    seed(JSON.stringify(JSON.stringify(["category:error", "source:passive-capture", "type:solution"])));
    migrate();
    expect(JSON.parse(new PromotedStore(db).getById("memory")!.tags)).toEqual(["source:passive-capture", "type:solution"]);
  });

  it("gives passive rows without a category a pattern type", () => {
    seed(JSON.stringify(["source:passive-capture", "hook:PostToolUse"]));
    migrate();
    expect(JSON.parse(new PromotedStore(db).getById("memory")!.tags))
      .toEqual(["source:passive-capture", "hook:PostToolUse", "type:pattern"]);
  });

  it("normalizes archived rows without returning them to search", () => {
    seed(JSON.stringify(JSON.stringify(["category:skill", "source:passive-capture"])), true);
    migrate();
    const row = new PromotedStore(db).getById("memory")!;
    expect(JSON.parse(row.tags)).toEqual(["source:passive-capture", "type:pattern"]);
    expect(row.archived_at).toBe("2025-02-01 00:00:00");
    expect(db.prepare("SELECT rowid FROM promoted_fts").all()).toEqual([]);
  });

  it.each(["broken json", '{"tag":"type:decision"}', '["type:decision",7]'])(
    "preserves undecodable tags without aborting the backfill: %s", (tags) => {
      seed(tags);
      migrate();
      expect(new PromotedStore(db).getById("memory")!.tags).toBe(tags);
    },
  );

  it("indexes repaired rows when FTS5 becomes available after the backfill", () => {
    seed(JSON.stringify(JSON.stringify(["category:task", "source:passive-capture"])));
    db.exec("DROP TABLE promoted_fts");
    migrate(false);
    migrate();
    expect(db.prepare("SELECT rowid FROM promoted_fts WHERE promoted_fts MATCH 'observation'").all()).toHaveLength(1);
    expect(new PromotedStore(db).search("Passive observation", 10, ["type:workflow"]).map((row) => row.id))
      .toEqual(["memory"]);
  });

  it("normalizes tags when FTS5 is unavailable", () => {
    db.exec("DROP TABLE promoted_fts");
    seed(JSON.stringify(JSON.stringify(["category:task", "source:passive-capture"])), true);
    migrate(false);
    expect(JSON.parse(new PromotedStore(db).getById("memory")!.tags)).toEqual(["source:passive-capture", "type:workflow"]);
  });
});
