// test/hooks/prompt-dedup.test.ts — one prompt's events are recorded once, whichever
// path recorded them. The two paths share no prompt id, only the text.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EventsDb } from "../../src/hooks/events-db.js";

const decision = { type: "decision", category: "decision", data: "use SQLite", priority: 1 };
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

describe("prompt event dedup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-dedup-"));
    dbPath = join(dir, "events.db");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records the first prompt and skips the second with the same text", () => {
    const db = new EventsDb(dbPath);
    const hash = hashOf("we decided to use SQLite");
    expect(db.insertPromptEvents("s1", [decision], hash)).toBe(1);
    expect(db.insertPromptEvents("s1", [decision], hash)).toBe(0);
    expect(db.getUnprocessed()).toHaveLength(1);
    db.close();
  });

  it("keeps the same text in a different session", () => {
    const db = new EventsDb(dbPath);
    const hash = hashOf("same words");
    db.insertPromptEvents("s1", [decision], hash);
    expect(db.insertPromptEvents("s2", [decision], hash)).toBe(1);
    expect(db.getUnprocessed()).toHaveLength(2);
    db.close();
  });

  it("records a different prompt in the same session", () => {
    const db = new EventsDb(dbPath);
    db.insertPromptEvents("s1", [decision], hashOf("first"));
    expect(db.insertPromptEvents("s1", [decision], hashOf("second"))).toBe(1);
    expect(db.getUnprocessed()).toHaveLength(2);
    db.close();
  });

  it("records every event of a prompt, not just one", () => {
    const db = new EventsDb(dbPath);
    const events = [decision, { ...decision, data: "and Postgres" }];
    expect(db.insertPromptEvents("s1", events, hashOf("two decisions"))).toBe(2);
    expect(db.insertPromptEvents("s1", events, hashOf("two decisions"))).toBe(0);
    expect(db.getUnprocessed()).toHaveLength(2);
    db.close();
  });

  it("records without a hash, as before", () => {
    const db = new EventsDb(dbPath);
    expect(db.insertPromptEvents("s1", [decision])).toBe(1);
    expect(db.insertPromptEvents("s1", [decision])).toBe(1);
    expect(db.getUnprocessed()).toHaveLength(2);
    db.close();
  });

  it("does not dedup a prompt against a tool call", () => {
    const db = new EventsDb(dbPath);
    db.insertToolCallEvents("s1", [decision], "PostToolUse", "toolu_1");
    expect(db.insertPromptEvents("s1", [decision], hashOf("unrelated"))).toBe(1);
    db.close();
  });

  it("migrates a v4 database and dedups from then on", () => {
    // A v4 DB: tool_use_id exists, prompt_hash does not.
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE events (
        event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        seq           INTEGER NOT NULL DEFAULT 0,
        type          TEXT NOT NULL,
        category      TEXT NOT NULL,
        data          TEXT NOT NULL,
        priority      INTEGER DEFAULT 3,
        source_hook   TEXT NOT NULL,
        tool_use_id   TEXT,
        prev_event_id INTEGER,
        processed_at  TEXT,
        created_at    TEXT DEFAULT (datetime('now'))
      );
    `);
    raw.prepare("INSERT INTO schema_version (version) VALUES (4)").run();
    raw.prepare(
      "INSERT INTO events (session_id, seq, type, category, data, priority, source_hook) " +
      "VALUES ('s1', 1, 'decision', 'decision', 'older row', 1, 'UserPromptSubmit')",
    ).run();
    raw.close();

    const db = new EventsDb(dbPath);
    const version = db.raw().prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(version.version).toBe(5);

    // The pre-migration row has no hash, so it never dedups against anything.
    const hash = hashOf("we decided to use SQLite");
    expect(db.insertPromptEvents("s1", [decision], hash)).toBe(1);
    expect(db.insertPromptEvents("s1", [decision], hash)).toBe(0);
    expect(db.getUnprocessed()).toHaveLength(2);
    db.close();
  });
});
