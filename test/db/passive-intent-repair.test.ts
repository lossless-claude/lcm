import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
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

function seed(id: string, content: string, tags: string, sessionId = "session", archived = false): void {
  db.prepare(`INSERT INTO promoted (id, content, tags, project_id, session_id, archived_at)
    VALUES (?, ?, ?, 'project', ?, ?)`)
    .run(id, content, tags, sessionId, archived ? "2025-01-01 00:00:00" : null);
  if (!archived) {
    db.prepare("INSERT INTO promoted_fts(rowid, content, tags) SELECT rowid, content, tags FROM promoted WHERE id = ?").run(id);
  }
}

describe("passive intent repair", () => {
  it("removes only exact passive intent labels, preserving manual memories and substantive insights", () => {
    const passiveTags = JSON.stringify(["source:passive-capture", "type:workflow"]);
    for (const label of ["implement", "investigate", "review", "refactor"]) {
      seed(`passive-${label}`, label, passiveTags);
      seed(`manual-${label}`, label, '["type:workflow"]', "manual");
    }
    seed("substantive", "review changes before merging", passiveTags);
    seed("case-sensitive", "Review", passiveTags);
    seed("whitespace", "implement ", passiveTags);
    seed("tag-substring", "implement", '["source:passive-capture-extra"]');
    seed("malformed", "implement", "broken json");
    seed("archived", "review", passiveTags, "session", true);
    // Manual storage can carry arbitrary tags; its session still establishes manual origin.
    seed("manual-passive-tag", "implement", passiveTags, "manual");

    runLcmMigrations(db);
    const store = new PromotedStore(db);
    for (const label of ["implement", "investigate", "review", "refactor"]) {
      expect(store.getById(`passive-${label}`)).toBeNull();
      expect(store.getById(`manual-${label}`)?.content).toBe(label);
      expect(store.search(label, 20).map((row) => row.id)).not.toContain(`passive-${label}`);
    }
    expect(store.getById("archived")).toBeNull();
    for (const id of ["substantive", "case-sensitive", "whitespace", "tag-substring", "malformed", "manual-passive-tag"]) {
      expect(store.getById(id)).not.toBeNull();
    }
    expect(db.prepare("SELECT count(*) AS n FROM promoted_fts").get()).toEqual({ n: 10 });
  });

  it("repairs legacy encoded passive tags even without FTS5", () => {
    const tags = JSON.stringify(JSON.stringify(["category:intent", "source:passive-capture"]));
    seed("encoded", "implement", tags);
    seed("manual", "implement", '["type:workflow"]', "manual");
    db.exec("DROP TABLE promoted_fts");

    runLcmMigrations(db, { fts5Available: false });
    expect(new PromotedStore(db).getById("encoded")).toBeNull();
    expect(new PromotedStore(db).getById("manual")?.content).toBe("implement");
    runLcmMigrations(db);
    expect(new PromotedStore(db).search("implement", 10).map((row) => row.id)).toEqual(["manual"]);
  });

  it("runs the repair only once per project database", () => {
    const tags = '["source:passive-capture"]';
    seed("old", "implement", tags);
    runLcmMigrations(db);
    expect(new PromotedStore(db).getById("old")).toBeNull();

    seed("later", "implement", tags);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    expect(store.getById("later")?.content).toBe("implement");
    expect(store.search("implement", 10).map((row) => row.id)).toEqual(["later"]);
  });
});
