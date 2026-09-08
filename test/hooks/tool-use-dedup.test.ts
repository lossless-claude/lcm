// test/hooks/tool-use-dedup.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "events.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

import { recordPostToolEvents } from "../../src/hooks/post-tool.js";
import { EventsDb } from "../../src/hooks/events-db.js";

/**
 * The command hook and the function-hooks module both receive Claude Code's
 * `tool_use_id`. A session that runs both (the remote gate loads the module
 * without CLAUDE_CODE_ENABLE_FUNCTION_HOOKS) must record each call once.
 */
describe("tool call dedup on (session_id, tool_use_id)", () => {
  let dir: string;

  function call(overrides: Record<string, unknown> = {}) {
    return recordPostToolEvents({
      session_id: "s1", cwd: dir, tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" }, tool_response: "yes",
      tool_use_id: "toolu_abc", ...overrides,
    } as never);
  }

  function rows() {
    const db = new DatabaseSync(join(dir, "events.db"), { readOnly: true });
    try {
      return db.prepare("SELECT session_id, tool_use_id FROM events").all() as {
        session_id: string; tool_use_id: string | null;
      }[];
    } finally { db.close(); }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-dedup-"));
    process.env.TEST_EVENTS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("records the same tool call once, whichever path arrives second", () => {
    const first = call();
    expect(first.recorded).toBeGreaterThan(0);

    const second = call({ hook_event_name: "PostToolUse" });
    expect(second.recorded).toBe(0);
    expect(second.hasPriority1).toBe(false);

    expect(rows()).toHaveLength(first.recorded);
    expect(rows().every((r) => r.tool_use_id === "toolu_abc")).toBe(true);
  });

  it("records two different calls in the same session", () => {
    const first = call();
    const second = call({ tool_use_id: "toolu_def" });
    expect(second.recorded).toBe(first.recorded);
    expect(rows()).toHaveLength(first.recorded + second.recorded);
  });

  it("records the same id in a different session", () => {
    const first = call();
    const other = call({ session_id: "s2" });
    expect(other.recorded).toBe(first.recorded);
  });

  it("still records a payload with no tool_use_id, and never dedups on it", () => {
    const first = call({ tool_use_id: undefined });
    const second = call({ tool_use_id: undefined });
    expect(first.recorded).toBeGreaterThan(0);
    expect(second.recorded).toBe(first.recorded);
    expect(rows().every((r) => r.tool_use_id === null)).toBe(true);
  });

  it("adds the column and index to a database written before the migration", () => {
    const path = join(dir, "events.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, category TEXT NOT NULL,
        data TEXT NOT NULL, priority INTEGER DEFAULT 3, source_hook TEXT NOT NULL,
        prev_event_id INTEGER, processed_at TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO schema_version (version) VALUES (3);
      INSERT INTO events (session_id, type, category, data, source_hook)
      VALUES ('s1', 'decision', 'c', '{}', 'PostToolUse');
    `);
    legacy.close();

    const db = new EventsDb(path);
    try {
      // The pre-migration row has no id, so it never dedups a later call against itself.
      expect(db.hasToolCall("s1", "toolu_abc")).toBe(false);
    } finally { db.close(); }

    expect(call().recorded).toBeGreaterThan(0);
    expect(call().recorded).toBe(0);
  });
});
