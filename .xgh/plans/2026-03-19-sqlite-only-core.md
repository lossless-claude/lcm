# SQLite-Only Core + Lazy Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Qdrant/Cipher/vllm-mlx from the critical path. Cross-session memory via SQLite FTS5. Daemon auto-spawns on demand (no LaunchAgents).

**Architecture:** `lcm_store` writes to a new SQLite `promoted` table with FTS5 index. `lcm_search` queries FTS5 across summaries + promoted, with optional Qdrant enhancement if detected. Daemon spawns lazily via `ensureDaemon()` called by MCP server and hooks. Idle timeout auto-exits daemon. No plists, no systemd units.

**Tech Stack:** Node.js 22+, SQLite (node:sqlite), Vitest, TypeScript (ES2022/NodeNext)

**Spec:** `../../../xgh/.xgh/specs/2026-03-19-lossless-claude-unified-router-pitch.md` (revised RFC)

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/db/promoted.ts` | PromotedStore class — CRUD + FTS5 search for promoted memories |
| `src/daemon/lifecycle.ts` | `ensureDaemon()` — PID file, health check, detached spawn, version check |
| `test/db/promoted.test.ts` | PromotedStore unit tests |
| `test/daemon/lifecycle.test.ts` | ensureDaemon unit tests |
| `test/daemon/routes/store.test.ts` | Store route integration tests |
| `test/daemon/routes/search.test.ts` | Search route integration tests |

### Modified files
| File | Change |
|---|---|
| `src/db/migration.ts` | Add `promoted` table + `promoted_fts` FTS5 virtual table |
| `src/daemon/routes/store.ts` | Write to SQLite promoted table (Qdrant optional, non-fatal) |
| `src/daemon/routes/search.ts` | Query promoted_fts + summaries_fts (Qdrant optional, non-fatal) |
| `src/daemon/server.ts` | Add idle timeout, add version to `/health` |
| `src/mcp/server.ts` | Load config, call `ensureDaemon()` before connecting |
| `src/hooks/compact.ts` | Call `ensureDaemon()` before POST |
| `src/hooks/restore.ts` | Call `ensureDaemon()` before POST |
| `bin/lossless-claude.ts` | Add `daemon start --detach` mode |
| `installer/install.ts` | Remove `setupDaemonService()`, `buildLaunchdPlist()`, `buildSystemdUnit()` |

---

## Phase 1: SQLite Cross-Session Memory

### Task 1: Add `promoted` table to migration

**Files:**
- Modify: `src/db/migration.ts:362-561` (add table + FTS5 at end of `runLcmMigrations`)
- Test: `test/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test to `test/migration.test.ts`:

```typescript
describe("promoted table migration", () => {
  it("creates promoted table and FTS5 index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claude-promoted-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "test.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db);

    // Table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='promoted'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    // FTS5 table exists
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
    runLcmMigrations(db); // second run

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='promoted'"
    ).all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migration.test.ts -t "promoted table migration"`
Expected: FAIL — `promoted` table does not exist

- [ ] **Step 3: Add promoted table to migration**

In `src/db/migration.ts`, add inside `runLcmMigrations()` before the FTS5 section:

```typescript
  // Promoted memories (cross-session, agent-stored)
  db.exec(`
    CREATE TABLE IF NOT EXISTS promoted (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      source_summary_id TEXT,
      project_id TEXT NOT NULL,
      session_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS promoted_project_idx ON promoted (project_id, created_at);
  `);
```

Then in the FTS5 section (after the `if (!fts5Available) return;` guard), add:

```typescript
  // Promoted FTS5
  const hasPromotedFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='promoted_fts'")
    .get();

  if (!hasPromotedFts) {
    db.exec(`
      CREATE VIRTUAL TABLE promoted_fts USING fts5(
        content,
        tags,
        tokenize='porter unicode61'
      );
    `);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migration.test.ts -t "promoted table migration"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migration.ts test/migration.test.ts
git commit -m "feat: add promoted table + FTS5 for cross-session memory"
```

---

### Task 2: Create PromotedStore

**Files:**
- Create: `src/db/promoted.ts`
- Create: `test/db/promoted.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/db/promoted.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/promoted.test.ts`
Expected: FAIL — cannot import `PromotedStore`

- [ ] **Step 3: Implement PromotedStore**

Create `src/db/promoted.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PromotedRow = {
  id: string;
  content: string;
  tags: string;
  source_summary_id: string | null;
  project_id: string;
  session_id: string | null;
  depth: number;
  confidence: number;
  created_at: string;
};

export type InsertParams = {
  content: string;
  tags?: string[];
  sourceSummaryId?: string;
  projectId: string;
  sessionId?: string;
  depth?: number;
  confidence?: number;
};

export type SearchResult = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  confidence: number;
  createdAt: string;
  rank: number;
};

export class PromotedStore {
  constructor(private db: DatabaseSync) {}

  insert(params: InsertParams): string {
    const id = randomUUID();
    const tags = JSON.stringify(params.tags ?? []);

    this.db.prepare(
      `INSERT INTO promoted (id, content, tags, source_summary_id, project_id, session_id, depth, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.content,
      tags,
      params.sourceSummaryId ?? null,
      params.projectId,
      params.sessionId ?? null,
      params.depth ?? 0,
      params.confidence ?? 1.0,
    );

    // Sync to FTS5
    const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (row) {
      this.db.prepare(
        "INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)"
      ).run(row.rowid, params.content, tags);
    }

    return id;
  }

  getById(id: string): PromotedRow | null {
    return (this.db.prepare("SELECT * FROM promoted WHERE id = ?").get(id) as PromotedRow) ?? null;
  }

  search(query: string, limit: number, filterTags?: string[]): SearchResult[] {
    // Sanitize query for FTS5 — wrap each token in double quotes
    const sanitized = query
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(" OR ");

    if (!sanitized) return [];

    const rows = this.db.prepare(
      `SELECT p.id, p.content, p.tags, p.project_id, p.confidence, p.created_at, rank
       FROM promoted_fts fts
       JOIN promoted p ON p.rowid = fts.rowid
       WHERE promoted_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    ).all(sanitized, limit) as Array<PromotedRow & { rank: number }>;

    let results = rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tags) as string[],
      projectId: r.project_id,
      confidence: r.confidence,
      createdAt: r.created_at,
      rank: r.rank,
    }));

    if (filterTags && filterTags.length > 0) {
      results = results.filter((r) => filterTags.every((t) => r.tags.includes(t)));
    }

    return results;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/promoted.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/promoted.ts test/db/promoted.test.ts
git commit -m "feat: add PromotedStore for cross-session SQLite memory"
```

---

### Task 3: Rewrite `lcm_store` route to use SQLite

**Files:**
- Modify: `src/daemon/routes/store.ts`
- Create: `test/daemon/routes/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/daemon/routes/store.test.ts`:

```typescript
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(tempDir: string) {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0; // random port
  return config;
}

describe("POST /store", () => {
  it("stores to SQLite promoted table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-"));
    tempDirs.push(tempDir);
    const config = makeConfig(tempDir);
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "We decided to use React",
          tags: ["decision"],
          cwd: tempDir,
        }),
      });
      const data = await res.json() as { stored: boolean };
      expect(res.status).toBe(200);
      expect(data.stored).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("returns 400 when text is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-store-err-"));
    tempDirs.push(tempDir);
    const config = makeConfig(tempDir);
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/store.test.ts`
Expected: FAIL — current store.ts calls `promoteSummary()` which requires qdrant-store.js

- [ ] **Step 3: Rewrite store route**

Replace `src/daemon/routes/store.ts`:

```typescript
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";

export function createStoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { text, tags = [], metadata = {}, cwd } = input;

    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    const projectPath = cwd || metadata.projectPath || "";
    if (!projectPath) {
      sendJson(res, 400, { error: "cwd or metadata.projectPath is required" });
      return;
    }

    try {
      // Core: write to SQLite promoted table
      const dbPath = projectDbPath(projectPath);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      const id = store.insert({
        content: text,
        tags,
        projectId: metadata.projectId ?? "manual",
        sessionId: metadata.sessionId ?? "manual",
        depth: metadata.depth ?? 0,
        confidence: 1.0,
      });
      db.close();

      // Optional: also promote to Qdrant (non-fatal)
      try {
        const { promoteSummary } = await import("../../promotion/promoter.js");
        await promoteSummary({
          text,
          tags,
          projectId: metadata.projectId ?? "manual",
          projectPath,
          depth: metadata.depth ?? 0,
          sessionId: metadata.sessionId ?? "manual",
          confidence: 1.0,
          collection: config.cipher.collection,
        });
      } catch {
        // Qdrant not available — SQLite is authoritative, this is fine
      }

      sendJson(res, 200, { stored: true, id });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "store failed" });
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/routes/store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/store.ts test/daemon/routes/store.test.ts
git commit -m "feat: lcm_store writes to SQLite promoted table, Qdrant optional"
```

---

### Task 4: Rewrite `lcm_search` route to query promoted FTS5

**Files:**
- Modify: `src/daemon/routes/search.ts`
- Create: `test/daemon/routes/search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/daemon/routes/search.test.ts`:

```typescript
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { projectDbPath } from "../../src/daemon/project.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /search", () => {
  it("finds promoted memories via FTS5", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-search-"));
    tempDirs.push(tempDir);

    // Pre-populate promoted table
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database is PostgreSQL", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { episodic: unknown[]; semantic: unknown[]; promoted: unknown[] };
      expect(res.status).toBe(200);
      expect(data.promoted.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  it("returns all three layers in response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-search-layers-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", cwd: tempDir }),
      });
      const data = await res.json() as Record<string, unknown>;
      expect(data).toHaveProperty("episodic");
      expect(data).toHaveProperty("semantic");
      expect(data).toHaveProperty("promoted");
    } finally {
      await daemon.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/search.test.ts`
Expected: FAIL — response has no `promoted` field

- [ ] **Step 3: Rewrite search route**

Replace `src/daemon/routes/search.ts`:

```typescript
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";
import { PromotedStore } from "../../db/promoted.js";

export function createSearchHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, limit = 5, layers, tags, cwd } = input;
    const activeLayers: string[] = layers ?? ["episodic", "semantic", "promoted"];
    const filterTags: string[] | undefined = Array.isArray(tags) && tags.length > 0 ? tags : undefined;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    let episodic: unknown[] = [];
    let semantic: unknown[] = [];
    let promoted: unknown[] = [];

    if (cwd) {
      const dbPath = projectDbPath(cwd);
      if (existsSync(dbPath)) {
        try {
          mkdirSync(dirname(dbPath), { recursive: true });
          const db = new DatabaseSync(dbPath);
          runLcmMigrations(db);

          // Episodic: FTS5 search across messages + summaries
          if (activeLayers.includes("episodic")) {
            try {
              const convStore = new ConversationStore(db);
              const summStore = new SummaryStore(db);
              const engine = new RetrievalEngine(convStore, summStore);
              const result = await engine.grep({ query, mode: "full_text", scope: "both" });
              const allMatches = [...result.messages, ...result.summaries];
              const episodicMatches = filterTags
                ? allMatches.filter((m) => {
                    const t = (m as Record<string, unknown>).tags;
                    return Array.isArray(t) && filterTags.every(ft => t.includes(ft));
                  })
                : allMatches;
              episodic = episodicMatches.slice(0, limit);
            } catch { /* non-fatal */ }
          }

          // Promoted: FTS5 search across promoted memories
          if (activeLayers.includes("promoted")) {
            try {
              const promotedStore = new PromotedStore(db);
              promoted = promotedStore.search(query, limit, filterTags);
            } catch { /* non-fatal */ }
          }

          db.close();
        } catch { /* non-fatal */ }
      }
    }

    // Semantic: Qdrant search (optional, non-fatal)
    if (activeLayers.includes("semantic")) {
      try {
        const require = createRequire(import.meta.url);
        const store = require(join(homedir(), ".local", "lib", "qdrant-store.js"));
        const results = await store.search(query, config.cipher.collection, limit, config.restoration.semanticThreshold);
        semantic = filterTags
          ? results.filter((r: any) => filterTags.every(t => r.payload?.tags?.includes(t)))
          : results;
      } catch { /* non-fatal — Qdrant may not be running */ }
    }

    sendJson(res, 200, { episodic, semantic, promoted });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/routes/search.test.ts`
Expected: PASS

- [ ] **Step 5: Run all existing tests to check for regressions**

Run: `npx vitest run`
Expected: All tests PASS. The new `promoted` field in the search response is additive — no existing consumer should break.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/search.ts test/daemon/routes/search.test.ts
git commit -m "feat: lcm_search queries promoted FTS5 + episodic + optional semantic"
```

---

## Phase 2: Lazy Daemon

### Task 5: Add version to `/health` endpoint

**Files:**
- Modify: `src/daemon/server.ts:35-36`

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/server.test.ts`:

```typescript
it("health endpoint returns version", async () => {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  const daemon = await createDaemon(config);
  const port = daemon.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json() as { status: string; version: string; uptime: number };
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.status).toBe("ok");
  } finally {
    await daemon.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.ts -t "health endpoint returns version"`
Expected: FAIL — no `version` field

- [ ] **Step 3: Add version to health route**

In `src/daemon/server.ts`, modify the health route:

```typescript
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// At module level:
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version;
  } catch { return "0.0.0"; }
})();

// In createDaemon, replace the health route:
routes.set("GET /health", async (_req, res) =>
  sendJson(res, 200, { status: "ok", version: PKG_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000) }));
```

Also export `PKG_VERSION` for use by lifecycle.ts:

```typescript
export { PKG_VERSION };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/server.test.ts -t "health endpoint returns version"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.ts test/daemon/server.test.ts
git commit -m "feat: /health returns version for daemon version checks"
```

---

### Task 6: Add idle timeout to daemon

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `bin/lossless-claude.ts`
- Modify: `src/daemon/config.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/server.test.ts`:

```typescript
it("auto-exits after idle timeout", async () => {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  config.daemon.idleTimeoutMs = 500; // 500ms for test
  const daemon = await createDaemon(config);
  const port = daemon.address().port;

  // Verify it's alive
  const res1 = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res1.ok).toBe(true);

  // Wait for idle timeout
  await new Promise(r => setTimeout(r, 700));

  // Should have exited — but since we can't test process.exit easily,
  // we verify the onIdle callback was called
  // (This test verifies the timer mechanism, not the actual exit)
  expect(daemon.idleTriggered).toBe(true);

  await daemon.stop();
});

it("resets idle timer on request", async () => {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  config.daemon.idleTimeoutMs = 500;
  const daemon = await createDaemon(config);
  const port = daemon.address().port;

  // Make requests to keep alive
  await fetch(`http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 300));
  await fetch(`http://127.0.0.1:${port}/health`);
  await new Promise(r => setTimeout(r, 300));

  // Should still be alive (timer reset)
  expect(daemon.idleTriggered).toBe(false);

  await daemon.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.ts -t "idle timeout"`
Expected: FAIL — `idleTimeoutMs` not in config, `idleTriggered` not on daemon

- [ ] **Step 3: Add idle timeout config**

In `src/daemon/config.ts`, add to the `daemon` section of `DaemonConfig` type and `DEFAULTS`:

```typescript
// In DaemonConfig type:
daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number; idleTimeoutMs: number };

// In DEFAULTS:
daemon: { port: 3737, socketPath: join(homedir(), ".lossless-claude", "daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 }, // 30 min
```

- [ ] **Step 4: Add idle timeout to daemon server**

In `src/daemon/server.ts`, modify `createDaemon`:

```typescript
// Add to DaemonInstance type:
export type DaemonInstance = {
  address: () => AddressInfo;
  stop: () => Promise<void>;
  registerRoute: (method: string, path: string, handler: RouteHandler) => void;
  idleTriggered: boolean;
};

// Inside createDaemon, add idle timer logic:
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleTriggered = false;

function resetIdleTimer() {
  if (config.daemon.idleTimeoutMs <= 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTriggered = true;
    if (config.daemon.idleTimeoutMs > 0) {
      console.log("[lcm] idle timeout — shutting down");
      process.exit(0);
    }
  }, config.daemon.idleTimeoutMs);
}

// In the request handler, after routing:
const server: Server = createServer(async (req, res) => {
  resetIdleTimer(); // <-- add this line
  const key = `${req.method} ${req.url?.split("?")[0]}`;
  // ... rest unchanged
});

// Start the initial timer:
resetIdleTimer();

// In the resolve callback, add idleTriggered to the returned instance:
resolve({
  address: () => server.address() as AddressInfo,
  get idleTriggered() { return idleTriggered; },
  stop: async () => {
    if (idleTimer) clearTimeout(idleTimer);
    // ... rest unchanged
  },
  registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/daemon/server.test.ts -t "idle"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.ts src/daemon/config.ts test/daemon/server.test.ts
git commit -m "feat: daemon auto-exits after configurable idle timeout"
```

---

### Task 7: Create `ensureDaemon()` lifecycle manager

**Files:**
- Create: `src/daemon/lifecycle.ts`
- Create: `test/daemon/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/daemon/lifecycle.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDaemon, type EnsureDaemonOptions } from "../../src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureDaemon", () => {
  it("connects to existing healthy daemon", async () => {
    // Simulate a running daemon by starting a real one
    const { createDaemon } = await import("../../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.daemon.idleTimeoutMs = 0; // no idle timeout in test
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    try {
      const result = await ensureDaemon({
        port,
        pidFilePath: pidFile,
        spawnTimeoutMs: 5000,
        _skipSpawn: true, // don't try to spawn, just connect
      });
      expect(result.connected).toBe(true);
      expect(result.port).toBe(port);
    } finally {
      await daemon.stop();
    }
  });

  it("returns connected=false when daemon is not running and spawn is skipped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-no-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");

    const result = await ensureDaemon({
      port: 19999, // nothing on this port
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });
    expect(result.connected).toBe(false);
  });

  it("cleans up stale PID file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-lifecycle-stale-"));
    tempDirs.push(tempDir);
    const pidFile = join(tempDir, "daemon.pid");
    writeFileSync(pidFile, "99999999"); // PID that doesn't exist

    const result = await ensureDaemon({
      port: 19999,
      pidFilePath: pidFile,
      spawnTimeoutMs: 1000,
      _skipSpawn: true,
    });

    expect(result.connected).toBe(false);
    expect(existsSync(pidFile)).toBe(false); // stale PID cleaned up
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/lifecycle.test.ts`
Expected: FAIL — cannot import `ensureDaemon`

- [ ] **Step 3: Implement ensureDaemon**

Create `src/daemon/lifecycle.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";

export type EnsureDaemonOptions = {
  port: number;
  pidFilePath: string;
  spawnTimeoutMs: number;
  expectedVersion?: string;
  _skipSpawn?: boolean; // for testing — don't attempt to spawn
  _fetchOverride?: typeof globalThis.fetch;
};

export type EnsureDaemonResult = {
  connected: boolean;
  port: number;
  spawned: boolean;
};

type HealthResponse = {
  status: string;
  version?: string;
  uptime?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStalePid(pidFilePath: string): void {
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
  } catch { /* ignore */ }
}

async function checkDaemonHealth(
  port: number,
  fetchFn: typeof globalThis.fetch,
): Promise<HealthResponse | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;

  // Step 1: Check if daemon is already running via health check
  const health = await checkDaemonHealth(opts.port, fetchFn);
  if (health?.status === "ok") {
    // Version check — if mismatch, kill and respawn
    if (opts.expectedVersion && health.version && health.version !== opts.expectedVersion) {
      // Read PID and kill old daemon
      if (existsSync(opts.pidFilePath)) {
        try {
          const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
          if (!isNaN(pid) && isProcessAlive(pid)) {
            process.kill(pid, "SIGTERM");
            await sleep(500);
          }
        } catch { /* ignore */ }
        cleanStalePid(opts.pidFilePath);
      }
      // Fall through to spawn
    } else {
      return { connected: true, port: opts.port, spawned: false };
    }
  }

  // Step 2: Check PID file for stale process
  if (existsSync(opts.pidFilePath)) {
    try {
      const pid = parseInt(readFileSync(opts.pidFilePath, "utf-8").trim(), 10);
      if (!isNaN(pid) && isProcessAlive(pid)) {
        // Process alive but health check failed — wait a bit and retry
        await sleep(1000);
        const retry = await checkDaemonHealth(opts.port, fetchFn);
        if (retry?.status === "ok") {
          return { connected: true, port: opts.port, spawned: false };
        }
      }
    } catch { /* ignore */ }
    cleanStalePid(opts.pidFilePath);
  }

  // Step 3: Spawn daemon (unless skipped for testing)
  if (opts._skipSpawn) {
    return { connected: false, port: opts.port, spawned: false };
  }

  const child = spawn("lossless-claude", ["daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  if (child.pid) {
    writeFileSync(opts.pidFilePath, String(child.pid));
  }

  // Step 4: Wait for health
  const deadline = Date.now() + opts.spawnTimeoutMs;
  while (Date.now() < deadline) {
    const h = await checkDaemonHealth(opts.port, fetchFn);
    if (h?.status === "ok") {
      return { connected: true, port: opts.port, spawned: true };
    }
    await sleep(300);
  }

  return { connected: false, port: opts.port, spawned: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/lifecycle.ts test/daemon/lifecycle.test.ts
git commit -m "feat: ensureDaemon() for lazy daemon spawn with PID management"
```

---

### Task 8: Wire ensureDaemon into MCP server and hooks

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/hooks/compact.ts`
- Modify: `src/hooks/restore.ts`
- Modify: `bin/lossless-claude.ts`

- [ ] **Step 1: Update MCP server to call ensureDaemon**

Modify `src/mcp/server.ts`:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { DaemonClient } from "../daemon/client.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { lcmGrepTool } from "./tools/lcm-grep.js";
import { lcmExpandTool } from "./tools/lcm-expand.js";
import { lcmDescribeTool } from "./tools/lcm-describe.js";
import { lcmSearchTool } from "./tools/lcm-search.js";
import { lcmStoreTool } from "./tools/lcm-store.js";

const TOOLS = [lcmGrepTool, lcmExpandTool, lcmDescribeTool, lcmSearchTool, lcmStoreTool];

const TOOL_ROUTES: Record<string, string> = {
  lcm_grep: "/grep",
  lcm_expand: "/expand",
  lcm_describe: "/describe",
  lcm_search: "/search",
  lcm_store: "/store",
};

export function getMcpToolDefinitions() { return TOOLS; }

export async function startMcpServer(): Promise<void> {
  const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
  const port = config.daemon.port;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");

  await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000 });

  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  const server = new Server({ name: "lossless-claude", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const route = TOOL_ROUTES[req.params.name];
    if (!route) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await client.post(route, { ...req.params.arguments, cwd: process.env.PWD ?? process.cwd() });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: Update hooks to call ensureDaemon**

Modify `src/hooks/compact.ts`:

```typescript
import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";

export async function handlePreCompact(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ summary: string }>("/compact", input);
    return { exitCode: 2, stdout: result.summary || "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
```

Modify `src/hooks/restore.ts`:

```typescript
import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";

export async function handleSessionStart(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ context: string }>("/restore", input);
    return { exitCode: 0, stdout: result.context || "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
```

- [ ] **Step 3: Add `--detach` flag to daemon start**

In `bin/lossless-claude.ts`, modify the `daemon` case:

```typescript
case "daemon": {
  if (argv[3] === "start") {
    if (argv.includes("--detach")) {
      // Spawn self as detached and exit
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      if (child.pid) {
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        writeFileSync(join(homedir(), ".lossless-claude", "daemon.pid"), String(child.pid));
        console.log(`lossless-claude daemon started in background (PID ${child.pid})`);
      }
      exit(0);
    }
    const { createDaemon } = await import("../src/daemon/server.js");
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const { createClaudeCliProxyManager } = await import("../src/daemon/proxy-manager.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
    const proxyManager = config.claudeCliProxy.enabled
      ? createClaudeCliProxyManager(config.claudeCliProxy)
      : undefined;
    const daemon = await createDaemon(config, { proxyManager });
    console.log(`lossless-claude daemon started on port ${daemon.address().port}`);
    process.on("SIGTERM", () => exit(0));
    process.on("SIGINT", () => exit(0));
  }
  break;
}
```

- [ ] **Step 4: Run existing hook tests to verify no regressions**

Run: `npx vitest run test/hooks/ test/mcp/`
Expected: Tests may need updating since hook signatures changed (added `port` param). Fix if needed — the `port` param is optional with default 3737, so existing tests should pass if daemon isn't expected to be running (ensureDaemon will try and fail gracefully).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/hooks/compact.ts src/hooks/restore.ts bin/lossless-claude.ts
git commit -m "feat: wire ensureDaemon into MCP server and hooks"
```

---

### Task 9: Remove LaunchAgent/systemd from installer

**Files:**
- Modify: `installer/install.ts`
- Modify: `test/installer/install.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/installer/install.test.ts`:

```typescript
describe("no LaunchAgent installation", () => {
  it("does not call launchctl or write plist", async () => {
    const deps = makeDeps();
    // Mock enough for install to proceed
    (deps.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (deps.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("no file"); });

    // install() would need to be partially mocked — instead verify setupDaemonService is removed
    expect(typeof (await import("../../installer/install.js")).setupDaemonService).toBe("undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/installer/install.test.ts -t "no LaunchAgent"`
Expected: FAIL — `setupDaemonService` is still exported

- [ ] **Step 3: Remove plist/systemd from installer**

In `installer/install.ts`:
1. Delete the `buildLaunchdPlist()` function
2. Delete the `buildSystemdUnit()` function
3. Delete the `setupDaemonService()` function
4. Remove the call to `setupDaemonService(deps)` in `install()` (step 8)
5. Remove the `launchctl` and `systemctl` imports/usage

Replace the daemon setup section in `install()` with:

```typescript
  // 8. Verify daemon can start (lazy daemon — no persistent service)
  console.log("Verifying daemon...");
  const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
  const daemonPort = configData?.daemon?.port ?? 3737;
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath: join(lcDir, "daemon.pid"),
    spawnTimeoutMs: 30000,
  });
  if (!connected) {
    console.warn("Warning: daemon not responding — run: lossless-claude doctor");
  } else {
    console.log("Daemon started successfully.");
  }
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run test/installer/install.test.ts`
Expected: Some tests may reference `setupDaemonService` or `buildLaunchdPlist` — update them to reflect the removal.

- [ ] **Step 5: Update installer tests**

Remove any tests that assert plist/systemd creation. Update tests that call `install()` to not expect `launchctl` or `systemctl` spawn calls.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "feat: remove LaunchAgent/systemd — daemon auto-spawns via ensureDaemon"
```

---

### Task 10: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test manual flow**

```bash
# Build
npm run build

# Kill any existing daemon
pkill -f "lossless-claude daemon" || true

# Verify daemon is not running
curl -s http://127.0.0.1:3737/health && echo "FAIL: daemon should be dead" || echo "OK: daemon not running"

# Start MCP server (should auto-spawn daemon)
echo '{"method":"tools/list"}' | timeout 10 lossless-claude mcp

# Verify daemon was spawned
curl -s http://127.0.0.1:3737/health | jq .

# Check PID file exists
cat ~/.lossless-claude/daemon.pid
```

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "chore: integration verification for SQLite-only core + lazy daemon"
```
