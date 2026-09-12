import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runLcmMigrations summary depth backfill", () => {
  it("adds depth and metadata from summary lineage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );

      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );

      CREATE TABLE summary_parents (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
    `);

    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)`).run(
      1,
      "legacy-session",
    );

    const insertSummaryStmt = db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    );
    insertSummaryStmt.run("sum_leaf_a", 1, "leaf", "leaf-a", 10);
    insertSummaryStmt.run("sum_leaf_b", 1, "leaf", "leaf-b", 10);
    insertSummaryStmt.run("sum_condensed_1", 1, "condensed", "condensed-1", 10);
    insertSummaryStmt.run("sum_condensed_2", 1, "condensed", "condensed-2", 10);
    insertSummaryStmt.run("sum_condensed_orphan", 1, "condensed", "condensed-orphan", 10);

    const insertMessageStmt = db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMessageStmt.run(1, 1, 1, "user", "m1", 5, "2026-01-01 10:00:00");
    insertMessageStmt.run(2, 1, 2, "assistant", "m2", 5, "2026-01-01 11:30:00");
    insertMessageStmt.run(3, 1, 3, "user", "m3", 5, "2026-01-01 12:45:00");

    const linkMessageStmt = db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkMessageStmt.run("sum_leaf_a", 1, 0);
    linkMessageStmt.run("sum_leaf_a", 2, 1);
    linkMessageStmt.run("sum_leaf_b", 3, 0);

    const linkStmt = db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkStmt.run("sum_condensed_1", "sum_leaf_a", 0);
    linkStmt.run("sum_condensed_1", "sum_leaf_b", 1);
    linkStmt.run("sum_condensed_2", "sum_condensed_1", 0);

    runLcmMigrations(db);

    const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{
      name?: string;
    }>;
    expect(summaryColumns.some((column) => column.name === "depth")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "earliest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "latest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_token_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "source_message_token_count")).toBe(true);

    const depthRows = db
      .prepare(
        `SELECT summary_id, depth, earliest_at, latest_at, descendant_count,
                descendant_token_count, source_message_token_count
         FROM summaries
         ORDER BY summary_id`,
      )
      .all() as Array<{
      summary_id: string;
      depth: number;
      earliest_at: string | null;
      latest_at: string | null;
      descendant_count: number;
      descendant_token_count: number;
      source_message_token_count: number;
    }>;
    const depthBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.depth]));
    const earliestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.earliest_at]));
    const latestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.latest_at]));
    const descendantCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_count]),
    );
    const descendantTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_token_count]),
    );
    const sourceMessageTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.source_message_token_count]),
    );

    expect(depthBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(depthBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(depthBySummaryId.get("sum_condensed_1")).toBe(1);
    expect(depthBySummaryId.get("sum_condensed_2")).toBe(2);
    expect(depthBySummaryId.get("sum_condensed_orphan")).toBe(1);

    const leafAEarliest = earliestBySummaryId.get("sum_leaf_a");
    const leafALatest = latestBySummaryId.get("sum_leaf_a");
    const leafBEarliest = earliestBySummaryId.get("sum_leaf_b");
    const leafBLatest = latestBySummaryId.get("sum_leaf_b");
    const condensed1Earliest = earliestBySummaryId.get("sum_condensed_1");
    const condensed1Latest = latestBySummaryId.get("sum_condensed_1");
    const condensed2Earliest = earliestBySummaryId.get("sum_condensed_2");
    const condensed2Latest = latestBySummaryId.get("sum_condensed_2");

    expect(leafAEarliest).toContain("2026-01-01");
    expect(leafALatest).toContain("2026-01-01");
    expect(leafBEarliest).toContain("2026-01-01");
    expect(leafBLatest).toContain("2026-01-01");
    expect(condensed1Earliest).toContain("2026-01-01");
    expect(condensed1Latest).toContain("2026-01-01");
    expect(condensed2Earliest).toContain("2026-01-01");
    expect(condensed2Latest).toContain("2026-01-01");

    expect(new Date(leafAEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafALatest as string).getTime(),
    );
    expect(new Date(leafBEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed1Latest as string).getTime(),
    );
    expect(new Date(condensed2Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed2Latest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafAEarliest as string).getTime(),
    );
    expect(new Date(condensed1Latest as string).getTime()).toBeGreaterThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(earliestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");
    expect(latestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");

    expect(descendantCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_condensed_1")).toBe(2);
    expect(descendantCountBySummaryId.get("sum_condensed_2")).toBe(3);
    expect(descendantCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(descendantTokenCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_1")).toBe(20);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_2")).toBe(30);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_a")).toBe(10);
    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_b")).toBe(5);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_1")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_2")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);
  });

  it("skips FTS tables when fts5 is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "no-fts.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const ftsTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
      .all() as Array<{ name: string }>;

    expect(ftsTables).toEqual([]);
  });
});

describe("promoted table migration", () => {
  it("creates promoted table and FTS5 index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-promoted-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='promoted'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const fts = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='promoted_fts'"
    ).all() as Array<{ name: string }>;
    expect(fts).toHaveLength(1);

    // Can insert and search
    db.prepare(
      "INSERT INTO promoted (id, content, tags, project_id) VALUES (?, ?, ?, ?)"
    ).run("p1", "We decided to use React for the frontend", '["decision"]', "proj-1");

    db.prepare(
      "INSERT INTO promoted_fts (rowid, content, tags) SELECT rowid, content, tags FROM promoted WHERE id = ?"
    ).run("p1");

    const results = db.prepare(
      "SELECT content FROM promoted_fts WHERE promoted_fts MATCH ?"
    ).all("React") as Array<{ content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("React");

    db.close();
  });

  it("is idempotent — running migration twice does not error", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-promoted-idem-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);
    runLcmMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='promoted'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    db.close();
  });
});

describe("redaction_stats table migration", () => {
  it("creates redaction_stats table with correct schema", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-redaction-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='redaction_stats'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const columns = db.prepare("PRAGMA table_info(redaction_stats)").all() as Array<{
      name: string;
      type: string;
    }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("project_id");
    expect(colNames).toContain("category");
    expect(colNames).toContain("count");

    // Can upsert and accumulate counts
    db.prepare(
      "INSERT INTO redaction_stats (project_id, category, count) VALUES (?, ?, ?)" +
      " ON CONFLICT(project_id, category) DO UPDATE SET count = count + excluded.count"
    ).run("proj-1", "built_in", 3);
    db.prepare(
      "INSERT INTO redaction_stats (project_id, category, count) VALUES (?, ?, ?)" +
      " ON CONFLICT(project_id, category) DO UPDATE SET count = count + excluded.count"
    ).run("proj-1", "built_in", 2);

    const row = db.prepare(
      "SELECT count FROM redaction_stats WHERE project_id = ? AND category = ?"
    ).get("proj-1", "built_in") as { count: number };
    expect(row.count).toBe(5);

    db.close();
  });

  it("is idempotent — running migration twice does not error", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-redaction-idem-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);
    runLcmMigrations(db);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='redaction_stats'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    db.close();
  });
});

describe("session_ingest_log table migration", () => {
  it("creates session_ingest_log table", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-session-ingest-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const info = db.prepare("PRAGMA table_info(session_ingest_log)").all() as Array<{ name: string }>;
    const columns = info.map((r) => r.name);
    expect(columns).toContain("session_id");
    expect(columns).toContain("completed_at");
    expect(columns).toContain("message_count");

    db.close();
  });

  it("session_ingest_log is idempotent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-session-ingest-idem-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });
    runLcmMigrations(db, { fts5Available: false }); // second run

    const info = db.prepare("PRAGMA table_info(session_ingest_log)").all() as Array<{ name: string }>;
    expect(info.length).toBeGreaterThan(0);

    db.close();
  });
});

describe("subagent attribution backfill", () => {
  function makeFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lossless-claude-subagent-fixture-"));
    tempDirs.push(dir);
    return dir;
  }

  function makeLegacyDb(): { db: ReturnType<typeof getLcmConnection>; dbPath: string } {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-subagent-backfill-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);
    // A conversations table shaped like it was before parent_session_id/subagent_type/subagent_desc existed.
    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    return { db, dbPath };
  }

  it("adds the three attribution columns to a legacy conversations table", () => {
    const { db } = makeLegacyDb();
    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const columns = (db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain("parent_session_id");
    expect(columns).toContain("subagent_type");
    expect(columns).toContain("subagent_desc");
    db.close();
  });

  it("fills attribution for an agent-% conversation from its sidecar, falling back to the owning folder", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'agent-child')`).run();

    const fixture = makeFixtureDir();
    const subagentsDir = join(fixture, "proj-hash", "owning-session", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-child.jsonl"), "");
    writeFileSync(
      join(subagentsDir, "agent-child.meta.json"),
      JSON.stringify({ agentType: "idea-explorer", description: "explore" }),
    );

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: fixture });

    const row = db
      .prepare(`SELECT parent_session_id, subagent_type, subagent_desc FROM conversations WHERE conversation_id = 1`)
      .get() as { parent_session_id: string | null; subagent_type: string | null; subagent_desc: string | null };
    expect(row).toEqual({
      parent_session_id: "owning-session",
      subagent_type: "idea-explorer",
      subagent_desc: "explore",
    });
    db.close();
  });

  it("resolves a nested dispatch's parentAgentId to the sibling's session id, not the owning session", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'agent-nested')`).run();

    const fixture = makeFixtureDir();
    const subagentsDir = join(fixture, "proj-hash", "owning-session", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-nested.jsonl"), "");
    writeFileSync(
      join(subagentsDir, "agent-nested.meta.json"),
      JSON.stringify({ agentType: "worker", parentAgentId: "dispatcher-id" }),
    );

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: fixture });

    const row = db
      .prepare(`SELECT parent_session_id FROM conversations WHERE conversation_id = 1`)
      .get() as { parent_session_id: string | null };
    expect(row.parent_session_id).toBe("agent-dispatcher-id");
    db.close();
  });

  it("leaves an agent-% conversation null and counts it unmatched when its transcript is gone from disk", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'agent-deleted')`).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const row = db
      .prepare(`SELECT parent_session_id, subagent_type, subagent_desc FROM conversations WHERE conversation_id = 1`)
      .get() as { parent_session_id: string | null; subagent_type: string | null; subagent_desc: string | null };
    expect(row).toEqual({ parent_session_id: null, subagent_type: null, subagent_desc: null });

    const marker = db
      .prepare(`SELECT unmatched_count FROM subagent_attribution_backfill WHERE id = 1`)
      .get() as { unmatched_count: number };
    expect(marker.unmatched_count).toBe(1);
    db.close();
  });

  it("never deletes a conversation row (UPDATE only, never DELETE)", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'agent-a'), (2, 'plain-session')`).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const count = db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it("runs the disk walk only once: a transcript that appears after the first run is never backfilled", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'agent-late')`).run();

    const fixture = makeFixtureDir();
    // First run: no transcript on disk yet — stays null, marker gets written.
    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: fixture });

    // Transcript shows up on disk after the fact.
    const subagentsDir = join(fixture, "proj-hash", "owning-session", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-late.jsonl"), "");
    writeFileSync(join(subagentsDir, "agent-late.meta.json"), JSON.stringify({ agentType: "late" }));

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: fixture }); // second run — should be a no-op

    const row = db
      .prepare(`SELECT parent_session_id, subagent_type FROM conversations WHERE conversation_id = 1`)
      .get() as { parent_session_id: string | null; subagent_type: string | null };
    expect(row).toEqual({ parent_session_id: null, subagent_type: null });

    const markerCount = db.prepare(`SELECT COUNT(*) AS n FROM subagent_attribution_backfill`).get() as { n: number };
    expect(markerCount.n).toBe(1);
    db.close();
  });

  it("does not touch a conversation whose session_id does not start with agent-", () => {
    const { db } = makeLegacyDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'plain-session')`).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const row = db
      .prepare(`SELECT parent_session_id FROM conversations WHERE conversation_id = 1`)
      .get() as { parent_session_id: string | null };
    expect(row.parent_session_id).toBeNull();
    db.close();
  });
});

describe("message_parts skill/command backfill (#421)", () => {
  function makeFixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lossless-claude-parts-fixture-"));
    tempDirs.push(dir);
    return dir;
  }

  /** A recent-legacy DB: every table modern except message_parts, whose CHECK predates 'skill'/'command'. */
  function makeLegacyMessagePartsDb(): { db: ReturnType<typeof getLcmConnection>; dbPath: string } {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-parts-backfill-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);
    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        role_tagging TEXT DEFAULT NULL,
        parent_session_id TEXT DEFAULT NULL,
        subagent_type TEXT DEFAULT NULL,
        subagent_desc TEXT DEFAULT NULL
      );

      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );

      CREATE TABLE message_parts (
        part_id TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        part_type TEXT NOT NULL CHECK (part_type IN (
          'text', 'reasoning', 'tool', 'patch', 'file',
          'subtask', 'compaction', 'step_start', 'step_finish',
          'snapshot', 'agent', 'retry'
        )),
        ordinal INTEGER NOT NULL,
        text_content TEXT,
        is_ignored INTEGER,
        is_synthetic INTEGER,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_status TEXT,
        tool_input TEXT,
        tool_output TEXT,
        tool_error TEXT,
        tool_title TEXT,
        patch_hash TEXT,
        patch_files TEXT,
        file_mime TEXT,
        file_name TEXT,
        file_url TEXT,
        subtask_prompt TEXT,
        subtask_desc TEXT,
        subtask_agent TEXT,
        step_reason TEXT,
        step_cost REAL,
        step_tokens_in INTEGER,
        step_tokens_out INTEGER,
        snapshot_hash TEXT,
        compaction_auto INTEGER,
        metadata TEXT,
        UNIQUE (message_id, ordinal)
      );
    `);
    return { db, dbPath };
  }

  it("rebuilds the part_type CHECK to admit 'skill' and 'command', keeping the existing row", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-compact')`).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES (1, 1, 0, 'system', 'compacted', 5)`,
    ).run();
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content)
       VALUES ('p1', 1, 'sess-compact', 'compaction', 0, 'compacted')`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const checkSql = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='message_parts'`).get() as { sql: string }
    ).sql;
    expect(checkSql).toContain("'skill'");
    expect(checkSql).toContain("'command'");

    // The pre-existing compaction row must survive the rebuild untouched.
    const preserved = db.prepare(`SELECT part_type, text_content FROM message_parts WHERE part_id = 'p1'`).get();
    expect(preserved).toEqual({ part_type: "compaction", text_content: "compacted" });

    // And the new enum values are actually usable now.
    expect(() =>
      db
        .prepare(
          `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_name)
           VALUES ('p2', 1, 'sess-compact', 'skill', 1, 'grilling')`,
        )
        .run(),
    ).not.toThrow();
    db.close();
  });

  it("backfills a command part straight from stored message content — no disk read", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-cmd')`).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
       VALUES (1, 1, 0, 'user', '<command-name>/model</command-name>
            <command-message>model</command-message>
            <command-args></command-args>', 5)`,
    ).run();

    // claudeProjectsDir points at an empty directory: nothing on disk to read for this part.
    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const rows = db
      .prepare(`SELECT part_type, tool_name, tool_input, message_id FROM message_parts WHERE part_type = 'command'`)
      .all() as Array<{ part_type: string; tool_name: string; tool_input: string | null; message_id: number }>;
    expect(rows).toEqual([{ part_type: "command", tool_name: "/model", tool_input: null, message_id: 1 }]);
    db.close();
  });

  it("backfills a skill part straight from stored message content — no disk read", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-skill')`).run();
    // Claude Code's own follow-up turn opens with this line verbatim, stored as a
    // plain string (not a content-block array), so it survives import untouched.
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
       VALUES (1, 1, 0, 'user', 'Launching skill: grilling
Full skill prompt follows...', 5)`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const rows = db
      .prepare(`SELECT part_type, tool_name, tool_input, message_id FROM message_parts WHERE part_type = 'skill'`)
      .all() as Array<{ part_type: string; tool_name: string; tool_input: string | null; message_id: number }>;
    expect(rows).toEqual([{ part_type: "skill", tool_name: "grilling", tool_input: null, message_id: 1 }]);
    db.close();
  });

  it("keeps the colon in a plugin:skill name — it is part of the name, not a separator", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-plugin-skill')`).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
       VALUES (1, 1, 0, 'user', 'Launching skill: superpowers:writing-plans', 5)`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const rows = db
      .prepare(`SELECT tool_name FROM message_parts WHERE part_type = 'skill'`)
      .all() as Array<{ tool_name: string }>;
    expect(rows).toEqual([{ tool_name: "superpowers:writing-plans" }]);
    db.close();
  });

  it("never deletes an existing message_parts row while backfilling", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-mixed')`).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES (1, 1, 0, 'system', 'compacted', 5)`,
    ).run();
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content)
       VALUES ('p1', 1, 'sess-mixed', 'compaction', 0, 'compacted')`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    const count = db.prepare(`SELECT COUNT(*) AS n FROM message_parts`).get() as { n: number };
    expect(count.n).toBeGreaterThanOrEqual(1);
    const preserved = db.prepare(`SELECT part_type FROM message_parts WHERE part_id = 'p1'`).get() as { part_type: string } | undefined;
    expect(preserved?.part_type).toBe("compaction");
    db.close();
  });

  it("runs the backfill only once: a command added to disk after the first run is never picked up", () => {
    const { db } = makeLegacyMessagePartsDb();
    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (1, 'sess-once')`).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES (1, 1, 0, 'user', 'plain text', 5)`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() });

    // A command message shows up afterward — as if written by a path this backfill doesn't own.
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
       VALUES (2, 1, 1, 'user', '<command-name>/model</command-name><command-args></command-args>', 5)`,
    ).run();

    runLcmMigrations(db, { fts5Available: false, claudeProjectsDir: makeFixtureDir() }); // second run — backfill is a no-op

    const rows = db.prepare(`SELECT COUNT(*) AS n FROM message_parts WHERE part_type = 'command'`).get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });
});
