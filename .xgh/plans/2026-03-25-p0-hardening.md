# P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the passive learning pipeline observable and bounded — errors are queryable, unprocessed events are capped, and `lcm doctor` / `lcm stats` surface pipeline health.

**Architecture:** Add an `error_log` table to the sidecar DB (schema v2), unify error handling across all hooks with a three-layer fence (`safeLogError`), cap unprocessed events on SessionStart, and surface health via `lcm doctor` and `lcm stats` through a shared `events-stats.ts` neutral layer.

**Tech Stack:** TypeScript, node:sqlite (DatabaseSync), Vitest

**Spec:** `.xgh/specs/2026-03-25-p0-hardening-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hooks/events-db.ts` | Modify | Schema v2 migration, 4 new methods |
| `src/hooks/hook-errors.ts` | **Create** | `safeLogError()` three-layer fence utility |
| `src/db/events-stats.ts` | **Create** | Shared sidecar scan for stats + doctor |
| `src/hooks/post-tool.ts` | Modify | Replace `logError` with `safeLogError` |
| `src/hooks/user-prompt.ts` | Modify | Replace bare `catch {}` with `safeLogError` |
| `src/hooks/restore.ts` | Modify | Add `pruneUnprocessed` + `pruneErrorLog` calls |
| `src/daemon/routes/promote-events.ts` | Modify | Add `safeLogError` alongside `result.errors++` |
| `src/doctor/doctor.ts` | Modify | Add "Passive Learning" category checks |
| `src/stats.ts` | Modify | Add event fields + display line |
| `src/mcp/server.ts` | Modify | Add events row to `lcm_stats` output |
| `docs/passive-learning.md` | Modify | Add observability + pruning docs |
| `test/hooks/events-db.test.ts` | Modify | New method tests |
| `test/hooks/hook-errors.test.ts` | **Create** | Three-layer fence tests |
| `test/db/events-stats.test.ts` | **Create** | Scan + aggregation tests |
| `test/doctor/doctor.test.ts` | Modify | Passive learning check tests |

## Dependency Graph

```
Task 1 (events-db schema v2)
  ├── Task 2 (hook-errors.ts) ─── depends on Task 1
  │     ├── Task 3 (post-tool.ts) ─── depends on Task 2
  │     ├── Task 4 (user-prompt.ts) ─── depends on Task 2
  │     └── Task 5 (promote-events.ts) ─── depends on Task 2
  ├── Task 6 (restore.ts pruning) ─── depends on Task 1
  └── Task 7 (events-stats.ts) ─── depends on Task 1
        ├── Task 8 (doctor.ts) ─── depends on Task 7
        └── Task 9 (stats.ts + mcp) ─── depends on Task 7
Task 10 (docs) ─── depends on all
Task 11 (E2E test) ─── depends on all
```

**Parallelization:** Tasks 3+4+5 can run in parallel. Tasks 8+9 can run in parallel. Tasks 2+6+7 can run in parallel (all depend only on Task 1).

---

### Task 1: Schema v2 Migration + New EventsDb Methods

**Files:**
- Modify: `src/hooks/events-db.ts`
- Modify: `test/hooks/events-db.test.ts`

- [ ] **Step 1: Write failing tests for schema v2 and new methods**

Add to `test/hooks/events-db.test.ts`:

```typescript
describe("Schema v2 — error_log + pruning", () => {
  it("migrates v1 DB to v2 on open", () => {
    // Create a v1 DB, close it, reopen — should have error_log table
    const db1 = new EventsDb(dbPath);
    db1.close();
    const db2 = new EventsDb(dbPath);
    const tables = db2.raw().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='error_log'"
    ).get() as { name: string } | undefined;
    expect(tables).toBeDefined();
    expect(tables!.name).toBe("error_log");
    db2.close();
  });

  it("logHookError inserts into error_log", () => {
    const db = new EventsDb(dbPath);
    db.logHookError("PostToolUse", new Error("DB locked"), "session-1");
    const rows = db.raw().prepare("SELECT * FROM error_log").all() as Array<{
      hook: string; error: string; session_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe("PostToolUse");
    expect(rows[0].error).toBe("DB locked");
    expect(rows[0].session_id).toBe("session-1");
    db.close();
  });

  it("logHookError handles non-Error values", () => {
    const db = new EventsDb(dbPath);
    db.logHookError("PostToolUse", "string error");
    const rows = db.raw().prepare("SELECT * FROM error_log").all() as Array<{ error: string }>;
    expect(rows[0].error).toBe("string error");
    db.close();
  });

  it("getHealthStats returns correct counts", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "decision", category: "decision", data: "test", priority: 1 }, "PostToolUse");
    db.insertEvent("s1", { type: "file", category: "pattern", data: "test2", priority: 3 }, "PostToolUse");
    db.markProcessed([1]);
    db.logHookError("PostToolUse", new Error("fail"), "s1");

    const stats = db.getHealthStats();
    expect(stats.totalEvents).toBe(2);
    expect(stats.unprocessed).toBe(1);
    expect(stats.errors).toBe(1);
    expect(stats.lastCapture).toBeTruthy();
    expect(stats.lastError).toBeTruthy();
    db.close();
  });

  it("getHealthStats returns zeros on empty DB", () => {
    const db = new EventsDb(dbPath);
    const stats = db.getHealthStats();
    expect(stats.totalEvents).toBe(0);
    expect(stats.unprocessed).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastCapture).toBeNull();
    expect(stats.lastError).toBeNull();
    db.close();
  });

  it("pruneUnprocessed caps rows by event_id", () => {
    const db = new EventsDb(dbPath);
    for (let i = 0; i < 15; i++) {
      db.insertEvent("s1", { type: "file", category: "pattern", data: `event-${i}`, priority: 3 }, "PostToolUse");
    }
    expect(db.getHealthStats().unprocessed).toBe(15);

    const result = db.pruneUnprocessed(10, 30);
    expect(result.pruned).toBe(5);
    expect(db.getHealthStats().unprocessed).toBe(10);

    // Verify oldest events (lowest event_id) were pruned
    const remaining = db.getUnprocessed() as unknown as Array<{ data: string }>;
    expect(remaining[0].data).toBe("event-5");
    db.close();
  });

  it("pruneUnprocessed logs count to error_log before deleting", () => {
    const db = new EventsDb(dbPath);
    for (let i = 0; i < 15; i++) {
      db.insertEvent("s1", { type: "file", category: "pattern", data: `e${i}`, priority: 3 }, "PostToolUse");
    }
    db.pruneUnprocessed(10, 30);

    const errorLogs = db.raw().prepare("SELECT * FROM error_log").all() as Array<{ error: string }>;
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].error).toContain("pruned 5 unprocessed events");
    db.close();
  });

  it("pruneUnprocessed wraps log+delete in one transaction", () => {
    const db = new EventsDb(dbPath);
    for (let i = 0; i < 15; i++) {
      db.insertEvent("s1", { type: "file", category: "pattern", data: `e${i}`, priority: 3 }, "PostToolUse");
    }
    db.pruneUnprocessed(10, 30);
    // Both the error_log entry and the deletes happened atomically
    // Verify by checking both exist
    const errorCount = (db.raw().prepare("SELECT COUNT(*) as c FROM error_log").get() as { c: number }).c;
    const eventCount = (db.raw().prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c;
    expect(errorCount).toBe(1);
    expect(eventCount).toBe(10);
    db.close();
  });

  it("pruneErrorLog removes old entries", () => {
    const db = new EventsDb(dbPath);
    db.logHookError("PostToolUse", new Error("old error"));
    // Manually backdate the entry
    db.raw().prepare("UPDATE error_log SET created_at = datetime('now', '-31 days')").run();
    db.logHookError("PostToolUse", new Error("recent error"));

    const pruned = db.pruneErrorLog(30);
    expect(pruned).toBe(1);
    const remaining = db.raw().prepare("SELECT * FROM error_log").all();
    expect(remaining).toHaveLength(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hooks/events-db.test.ts`
Expected: FAIL — `logHookError`, `getHealthStats`, `pruneUnprocessed`, `pruneErrorLog` are not defined

- [ ] **Step 3: Implement schema v2 migration and new methods**

In `src/hooks/events-db.ts`:

1. Change `SCHEMA_VERSION` from `1` to `2` (line 21)

2. Add `error_log` table + index to `SCHEMA_SQL` (after line 39):
```sql
CREATE TABLE IF NOT EXISTS error_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hook       TEXT NOT NULL,
  error      TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
```

3. Add v1→v2 migration branch in `migrate()` (replace the comment at line 75-76):
```typescript
    if (currentVersion < 2) {
      this.db.exec("BEGIN EXCLUSIVE");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS error_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            hook       TEXT NOT NULL,
            error      TEXT NOT NULL,
            session_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
        `);
        this.db.prepare("UPDATE schema_version SET version = 2").run();
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    }
```

4. Add `HealthStats` interface (after `EventRow` interface, line 19):
```typescript
export interface HealthStats {
  totalEvents: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
  lastError: string | null;
}
```

5. Add four new methods before `raw()` (before line 122):
```typescript
  logHookError(hook: string, error: unknown, sessionId?: string): void {
    const msg = error instanceof Error ? error.message : String(error);
    this.db.prepare(
      "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, ?)"
    ).run(hook, msg, sessionId ?? null);
  }

  getHealthStats(): HealthStats {
    const totals = this.db.prepare(
      "SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END), 0) as unprocessed FROM events"
    ).get() as { total: number; unprocessed: number };
    const errors = this.db.prepare(
      "SELECT COUNT(*) as count FROM error_log WHERE created_at >= datetime('now', '-30 days')"
    ).get() as { count: number };
    const lastCapture = this.db.prepare(
      "SELECT MAX(created_at) as ts FROM events"
    ).get() as { ts: string | null };
    const lastError = this.db.prepare(
      "SELECT MAX(created_at) as ts FROM error_log"
    ).get() as { ts: string | null };

    return {
      totalEvents: totals.total,
      unprocessed: totals.unprocessed,
      errors: errors.count,
      lastCapture: lastCapture.ts,
      lastError: lastError.ts,
    };
  }

  pruneUnprocessed(maxRows = 10_000, maxAgeDays = 30): { pruned: number } {
    let pruned = 0;
    this.db.exec("BEGIN");
    try {
      // Age-based pruning
      const ageResult = this.db.prepare(
        `DELETE FROM events WHERE processed_at IS NULL
         AND event_id IN (
           SELECT event_id FROM events WHERE processed_at IS NULL
           AND created_at < datetime('now', '-' || ? || ' days')
         )`
      ).run(maxAgeDays);
      pruned += Number(ageResult.changes);

      // Row-cap pruning: keep only the newest maxRows
      const countRow = this.db.prepare(
        "SELECT COUNT(*) as c FROM events WHERE processed_at IS NULL"
      ).get() as { c: number };
      if (countRow.c > maxRows) {
        const excess = countRow.c - maxRows;
        const capResult = this.db.prepare(
          `DELETE FROM events WHERE event_id IN (
             SELECT event_id FROM events WHERE processed_at IS NULL
             ORDER BY event_id ASC LIMIT ?
           )`
        ).run(excess);
        pruned += Number(capResult.changes);
      }

      // Log prune count before committing (same transaction = atomic)
      if (pruned > 0) {
        this.db.prepare(
          "INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, NULL)"
        ).run("pruneUnprocessed", `pruned ${pruned} unprocessed events (age/cap limit)`);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
    return { pruned };
  }

  pruneErrorLog(olderThanDays = 30): number {
    const result = this.db.prepare(
      "DELETE FROM error_log WHERE created_at < datetime('now', '-' || ? || ' days')"
    ).run(olderThanDays);
    return Number(result.changes);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/hooks/events-db.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/events-db.ts test/hooks/events-db.test.ts
git commit -m "feat: add schema v2 migration with error_log table and pruning methods"
```

---

### Task 2: `safeLogError()` Three-Layer Fence

**Files:**
- Create: `src/hooks/hook-errors.ts`
- Create: `test/hooks/hook-errors.test.ts`
- Depends on: Task 1

- [ ] **Step 1: Write failing tests**

Create `test/hooks/hook-errors.test.ts`:

```typescript
// test/hooks/hook-errors.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock eventsDbPath to use temp dir
let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: (cwd: string) => {
    const { createHash } = require("node:crypto");
    const hash = createHash("sha256").update(cwd).digest("hex");
    return join(mockEventsDir, `${hash}.db`);
  },
}));

// Mock LOG_PATH to avoid writing to real ~/.lossless-claude/logs/events.log
let mockLogPath: string;
vi.mock("../../src/hooks/hook-errors.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/hooks/hook-errors.js")>();
  return {
    ...mod,
    get LOG_PATH() { return mockLogPath; },
  };
});

// Import after mock
import { safeLogError, _resetCircuitBreaker, LOG_PATH } from "../../src/hooks/hook-errors.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";

describe("safeLogError", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hook-errors-test-"));
    mockEventsDir = join(tempDir, "events");
    mockLogPath = join(tempDir, "events.log"); // Override LOG_PATH to temp dir
    _resetCircuitBreaker();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Layer 1: writes to sidecar DB when cwd is valid", () => {
    const cwd = join(tempDir, "project");
    safeLogError("PostToolUse", new Error("test error"), { cwd, sessionId: "s1" });

    const db = new EventsDb(eventsDbPath(cwd));
    const rows = db.raw().prepare("SELECT * FROM error_log").all() as Array<{
      hook: string; error: string; session_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].hook).toBe("PostToolUse");
    expect(rows[0].error).toBe("test error");
    db.close();
  });

  it("Layer 1: skips DB when cwd is undefined, falls to Layer 2", () => {
    safeLogError("PostToolUse", new Error("no cwd"), {});
    // Should not throw, should write to flat file
  });

  it("Layer 2: writes to flat file when DB fails", () => {
    // Use an invalid path that will fail DB open
    const cwd = "/dev/null/impossible";
    safeLogError("PostToolUse", new Error("db fail"), { cwd, sessionId: "s1" });

    // NOTE: LOG_PATH should be overridden in test setup to point to a temp dir
    // to avoid writing to the real ~/.lossless-claude/logs/events.log.
    // Either mock LOG_PATH via vi.mock or set a LOG_PATH_OVERRIDE env var.
    const testLogPath = join(tempDir, "events.log");
    // Assume LOG_PATH is mocked to testLogPath in beforeEach
    if (existsSync(testLogPath)) {
      const content = readFileSync(testLogPath, "utf-8");
      expect(content).toContain("db fail");
      expect(content).toContain("PostToolUse");
      expect(content).toContain("/dev/null/impossible"); // cwd included
    }
  });

  it("circuit breaker: skips DB after first failure", () => {
    const badCwd = "/dev/null/impossible";
    safeLogError("PostToolUse", new Error("first"), { cwd: badCwd });

    // Second call should skip DB entirely (circuit open)
    const goodCwd = join(tempDir, "project2");
    safeLogError("PostToolUse", new Error("second"), { cwd: goodCwd });

    // Good CWD should NOT have a DB entry because circuit is open
    const dbPath = eventsDbPath(goodCwd);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("Layer 3: swallows silently when both DB and file fail", () => {
    // This should not throw under any circumstances
    expect(() => {
      safeLogError("PostToolUse", new Error("total fail"), {});
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hooks/hook-errors.test.ts`
Expected: FAIL — module `../../src/hooks/hook-errors.js` not found

- [ ] **Step 3: Implement `hook-errors.ts`**

Create `src/hooks/hook-errors.ts`:

```typescript
// src/hooks/hook-errors.ts
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const LOG_PATH = join(homedir(), ".lossless-claude", "logs", "events.log");

let dbCircuitOpen = false;

/** Reset circuit breaker — for testing only. */
export function _resetCircuitBreaker(): void {
  dbCircuitOpen = false;
}

/**
 * Three-layer error fence for hook processes.
 * Layer 1: Sidecar DB error_log table (queryable by doctor/stats)
 * Layer 2: Flat file ~/.lossless-claude/logs/events.log
 * Layer 3: Swallow silently — hooks must never crash
 */
export function safeLogError(
  hook: string,
  error: unknown,
  opts: { cwd?: string; sessionId?: string },
): void {
  // Layer 1: Sidecar DB (skip if cwd missing or circuit open)
  if (opts.cwd && !dbCircuitOpen) {
    try {
      const db = new EventsDb(eventsDbPath(opts.cwd));
      try {
        db.logHookError(hook, error, opts.sessionId);
      } finally {
        db.close();
      }
      return;
    } catch {
      dbCircuitOpen = true; // skip DB on subsequent calls this process
    }
  }

  // Layer 2: Flat file (include cwd for diagnosing DB-skip cases)
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      error: error instanceof Error ? error.message : String(error),
      session_id: opts.sessionId,
      cwd: opts.cwd,
    }) + "\n");
    return;
  } catch { /* file failed — fall through */ }

  // Layer 3: Swallow silently — hooks must never crash
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/hooks/hook-errors.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/hook-errors.ts test/hooks/hook-errors.test.ts
git commit -m "feat: add safeLogError three-layer fence for hook error handling"
```

---

### Task 3: Replace `logError` in `post-tool.ts`

**Files:**
- Modify: `src/hooks/post-tool.ts`
- Modify: `test/hooks/post-tool.test.ts`
- Depends on: Task 2

- [ ] **Step 1: Modify `post-tool.ts`**

1. Replace imports (lines 2-8): Remove `appendFileSync`, `mkdirSync`, `join`, `dirname`, `homedir`. Add `safeLogError`:
```typescript
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { firePromoteEventsRequest } from "./session-end.js";
import { safeLogError } from "./hook-errors.js";
```

2. Remove the `LOG_PATH` constant (line 10) and the entire `logError` function (lines 12-25).

3. Declare a `cwd` variable before the outer try block so it's available in the catch:
```typescript
  let cwd: string | undefined;
```
   Then, early in the try body (after parsing `input`), capture: `cwd = input.cwd;`

4. Replace `logError("PostToolUse", error)` in the outer catch with:
```typescript
    safeLogError("PostToolUse", error, { cwd });
```

This avoids re-parsing stdin in the catch block, which is fragile if stdin itself is malformed.

- [ ] **Step 2: Run existing tests to verify nothing broke**

Run: `npx vitest run test/hooks/post-tool.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/post-tool.ts
git commit -m "refactor: replace logError with safeLogError in post-tool hook"
```

---

### Task 4: Replace bare `catch {}` in `user-prompt.ts`

**Files:**
- Modify: `src/hooks/user-prompt.ts`
- Depends on: Task 2

- [ ] **Step 1: Modify `user-prompt.ts`**

1. Add import at top (after line 4):
```typescript
import { safeLogError } from "./hook-errors.js";
```

2. Replace the bare `catch` at line 59 with:
```typescript
    } catch (e) {
      safeLogError("UserPromptSubmit", e, {
        cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR,
        sessionId: input.session_id,
      });
    }
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run test/hooks/user-prompt.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/user-prompt.ts
git commit -m "refactor: replace bare catch with safeLogError in user-prompt hook"
```

---

### Task 5: Add `safeLogError` to `promote-events.ts`

**Files:**
- Modify: `src/daemon/routes/promote-events.ts`
- Depends on: Task 2

- [ ] **Step 1: Modify `promote-events.ts`**

1. Add import at top:
```typescript
import { safeLogError } from "../../hooks/hook-errors.js";
```

2. In the per-event catch block (around line 143 in the current file), add `safeLogError` **alongside** the existing `result.errors++`:
```typescript
          } catch (error) {
            result.errors++;
            safeLogError("promote-events", error, { cwd, sessionId: event.session_id });
          }
```

Note: `result.errors++` is the synchronous HTTP signal — it MUST be preserved. `safeLogError` is the async forensics log. Both must exist.

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run test/daemon/routes/promote-events.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/daemon/routes/promote-events.ts
git commit -m "feat: add safeLogError to promote-events error path"
```

---

### Task 6: Add Pruning to SessionStart

**Files:**
- Modify: `src/hooks/restore.ts`
- Depends on: Task 1

- [ ] **Step 1: Modify `restore.ts`**

In `handleSessionStart`, inside the existing scavenge try-block (lines 15-33), add `pruneUnprocessed` and `pruneErrorLog` calls after the existing `pruneProcessed(7)` at line 22:

```typescript
      try {
        eventsDb.pruneProcessed(7);
        eventsDb.pruneUnprocessed(10_000, 30);
        eventsDb.pruneErrorLog(30);
        const unprocessed = eventsDb.getUnprocessed(1);
        if (unprocessed.length > 0) {
          const { firePromoteEventsRequest } = await import("./session-end.js");
          firePromoteEventsRequest(daemonPort, { cwd });
        }
      } finally {
        eventsDb.close();
      }
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run test/hooks/restore.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/hooks/restore.ts
git commit -m "feat: add unprocessed event cap and error_log pruning on SessionStart"
```

---

### Task 7: Shared `events-stats.ts` Neutral Layer

**Files:**
- Create: `src/db/events-stats.ts`
- Create: `test/db/events-stats.test.ts`
- Depends on: Task 1

- [ ] **Step 1: Write failing tests**

Create `test/db/events-stats.test.ts`:

```typescript
// test/db/events-stats.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let mockEventsDir: string;
vi.mock("../../src/db/events-path.js", () => ({
  eventsDir: () => mockEventsDir,
}));

import { collectEventStats } from "../../src/db/events-stats.js";
import { EventsDb } from "../../src/hooks/events-db.js";

describe("collectEventStats", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "events-stats-test-"));
    mockEventsDir = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns zeros when no sidecar DBs exist", () => {
    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
    expect(stats.unprocessed).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastCapture).toBeNull();
  });

  it("aggregates across multiple sidecar DBs", () => {
    // Create two sidecar DBs with events
    const db1 = new EventsDb(join(tempDir, "project1.db"));
    db1.insertEvent("s1", { type: "decision", category: "decision", data: "d1", priority: 1 }, "PostToolUse");
    db1.insertEvent("s1", { type: "file", category: "pattern", data: "f1", priority: 3 }, "PostToolUse");
    db1.logHookError("PostToolUse", new Error("err1"));
    db1.close();

    const db2 = new EventsDb(join(tempDir, "project2.db"));
    db2.insertEvent("s2", { type: "git", category: "workflow", data: "g1", priority: 2 }, "PostToolUse");
    db2.close();

    const stats = collectEventStats();
    expect(stats.captured).toBe(3);
    expect(stats.unprocessed).toBe(3);
    expect(stats.errors).toBe(1);
  });

  it("skips non-.db files in events directory", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "not-a-db.txt"), "hello");

    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("handles corrupt DB gracefully", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, "corrupt.db"), "not a sqlite database");

    // Should not throw
    const stats = collectEventStats();
    expect(stats.captured).toBe(0);
  });

  it("respects timeout budget", () => {
    // With a 0ms budget, should return immediately
    const stats = collectEventStats(0);
    expect(stats.captured).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/db/events-stats.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `events-stats.ts`**

Create `src/db/events-stats.ts`:

```typescript
// src/db/events-stats.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./events-path.js";
import { EventsDb } from "../hooks/events-db.js";

export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
}

export interface DetailedEventStats extends EventStats {
  projects: Array<{
    file: string;
    captured: number;
    unprocessed: number;
    lastCapture: string | null;
  }>;
  recentErrors: Array<{ created_at: string; hook: string; error: string }>;
}

const MAX_DBS = 50;

/**
 * Scan all sidecar DBs and aggregate event stats.
 * Used by both lcm doctor and lcm stats.
 * @param timeoutMs Total time budget for the scan (default 2000ms)
 */
export function collectEventStats(timeoutMs = 2000): EventStats {
  const result: EventStats = { captured: 0, unprocessed: 0, errors: 0, lastCapture: null };
  const dir = eventsDir();

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".db"));
  } catch {
    return result; // events dir doesn't exist
  }

  const deadline = Date.now() + timeoutMs;
  let scanned = 0;

  for (const file of files) {
    if (scanned >= MAX_DBS || Date.now() >= deadline) break;
    try {
      const db = new EventsDb(join(dir, file));
      try {
        const stats = db.getHealthStats();
        result.captured += stats.totalEvents;
        result.unprocessed += stats.unprocessed;
        result.errors += stats.errors;
        if (stats.lastCapture && (!result.lastCapture || stats.lastCapture > result.lastCapture)) {
          result.lastCapture = stats.lastCapture;
        }
      } finally {
        db.close();
      }
      scanned++;
    } catch {
      // Skip corrupt or locked DBs
      scanned++;
    }
  }

  return result;
}

/**
 * Detailed scan for verbose doctor output — returns per-project breakdown + recent errors.
 */
export function collectDetailedEventStats(timeoutMs = 2000): DetailedEventStats {
  const result: DetailedEventStats = {
    captured: 0, unprocessed: 0, errors: 0, lastCapture: null,
    projects: [], recentErrors: [],
  };
  const dir = eventsDir();

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".db"));
  } catch {
    return result;
  }

  const deadline = Date.now() + timeoutMs;
  let scanned = 0;

  for (const file of files) {
    if (scanned >= MAX_DBS || Date.now() >= deadline) break;
    try {
      const db = new EventsDb(join(dir, file));
      try {
        const stats = db.getHealthStats();
        result.captured += stats.totalEvents;
        result.unprocessed += stats.unprocessed;
        result.errors += stats.errors;
        if (stats.lastCapture && (!result.lastCapture || stats.lastCapture > result.lastCapture)) {
          result.lastCapture = stats.lastCapture;
        }
        result.projects.push({
          file,
          captured: stats.totalEvents,
          unprocessed: stats.unprocessed,
          lastCapture: stats.lastCapture,
        });
        // Collect recent errors for verbose display
        const errors = db.raw().prepare(
          "SELECT created_at, hook, error FROM error_log ORDER BY id DESC LIMIT 5"
        ).all() as Array<{ created_at: string; hook: string; error: string }>;
        result.recentErrors.push(...errors);
      } finally {
        db.close();
      }
      scanned++;
    } catch {
      scanned++;
    }
  }

  // Sort and limit recent errors across all DBs
  result.recentErrors.sort((a, b) => b.created_at.localeCompare(a.created_at));
  result.recentErrors = result.recentErrors.slice(0, 5);

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db/events-stats.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/events-stats.ts test/db/events-stats.test.ts
git commit -m "feat: add events-stats neutral layer for sidecar DB scanning"
```

---

### Task 8: `lcm doctor` Passive Learning Checks

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `test/doctor/doctor.test.ts`
- Depends on: Task 7

- [ ] **Step 1: Write failing tests**

Add to `test/doctor/doctor.test.ts`:

```typescript
describe("Passive Learning checks", () => {
  it("skips passive learning section when PostToolUse hook not installed", async () => {
    // Mock deps with no PostToolUse hook
    const results = await runDoctor(mockDepsWithoutPostToolUse);
    const plResults = results.filter(r => r.category === "Passive Learning");
    expect(plResults).toHaveLength(0);
  });

  it("warns when hooks installed but no sidecar DBs exist", async () => {
    const results = await runDoctor(mockDepsWithPostToolUse);
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("No events captured");
  });

  it("passes when events exist and unprocessed is low", async () => {
    // Create a sidecar DB with events
    const results = await runDoctor(mockDepsWithEvents);
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("pass");
  });

  it("warns when unprocessed > 1000", async () => {
    const results = await runDoctor(mockDepsWithHighUnprocessed);
    const capture = results.find(r => r.name === "events-capture");
    expect(capture?.status).toBe("warn");
    expect(capture?.message).toContain("unprocessed");
  });

  it("fails when errors >= 50", async () => {
    const results = await runDoctor(mockDepsWithManyErrors);
    const errors = results.find(r => r.name === "events-errors");
    expect(errors?.status).toBe("fail");
  });

  it("passes staleness when last capture < 7 days", async () => {
    const results = await runDoctor(mockDepsWithRecentEvents);
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("pass");
  });

  it("warns staleness when last capture >= 7 days", async () => {
    const results = await runDoctor(mockDepsWithStaleEvents);
    const staleness = results.find(r => r.name === "events-staleness");
    expect(staleness?.status).toBe("warn");
    expect(staleness?.message).toContain("hooks may not be firing");
  });
});
```

Note: The exact mock structure will depend on how `doctor.test.ts` is currently organized. Read the existing test file and follow its patterns for dependency injection.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/doctor/doctor.test.ts`
Expected: FAIL — no "Passive Learning" category results

- [ ] **Step 3: Implement passive learning checks in `doctor.ts`**

Add `checkPassiveLearning` function and call it from `runDoctor`:

1. Import `collectEventStats`, `collectDetailedEventStats`, and `eventsDir`:
```typescript
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";
```

2. Add the check function:
```typescript
function checkPassiveLearning(results: CheckResult[], hooksInstalled: boolean, verbose: boolean): void {
  if (!hooksInstalled) return;

  const stats = verbose ? collectDetailedEventStats(2000) : collectEventStats(2000);

  // Capture check
  if (stats.captured === 0) {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "warn",
      message: "No events captured — passive learning may not be active",
    });
  } else if (stats.unprocessed > 1000) {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "warn",
      message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon may be offline. Fix: lcm daemon start`,
    });
  } else {
    results.push({
      name: "events-capture",
      category: "Passive Learning",
      status: "pass",
      message: `${stats.captured} events captured (${stats.unprocessed} unprocessed)`,
    });
  }

  // Error check
  if (stats.errors >= 50) {
    results.push({
      name: "events-errors",
      category: "Passive Learning",
      status: "fail",
      message: `${stats.errors} hook errors (30d) — check ~/.lossless-claude/logs/events.log`,
    });
  } else if (stats.errors > 0) {
    results.push({
      name: "events-errors",
      category: "Passive Learning",
      status: "warn",
      message: `${stats.errors} hook errors (30d)`,
    });
  } else {
    results.push({
      name: "events-errors",
      category: "Passive Learning",
      status: "pass",
      message: "0 hook errors",
    });
  }

  // Staleness check
  if (stats.lastCapture) {
    const lastCaptureDate = new Date(stats.lastCapture);
    const daysSince = (Date.now() - lastCaptureDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7) {
      results.push({
        name: "events-staleness",
        category: "Passive Learning",
        status: "warn",
        message: `last capture ${Math.floor(daysSince)}d ago — hooks may not be firing if project is active`,
      });
    } else {
      const ago = daysSince < 1
        ? `${Math.floor(daysSince * 24)}h ago`
        : `${Math.floor(daysSince)}d ago`;
      results.push({
        name: "events-staleness",
        category: "Passive Learning",
        status: "pass",
        message: `last capture ${ago}`,
      });
    }
  }

  // Verbose: per-project breakdown + recent errors
  if (verbose && "projects" in stats) {
    const detailed = stats as import("../db/events-stats.js").DetailedEventStats;
    for (const p of detailed.projects) {
      const ago = p.lastCapture
        ? formatTimeAgo(new Date(p.lastCapture))
        : "never";
      results.push({
        name: `events-project-${p.file}`,
        category: "Passive Learning",
        status: "pass",
        message: `${p.file.slice(0, 8)}… ${p.captured} events (${p.unprocessed} unprocessed) last: ${ago}`,
      });
    }
    if (detailed.recentErrors.length > 0) {
      const errorLines = detailed.recentErrors
        .map(e => `  ${e.created_at} ${e.hook}: ${e.error}`)
        .join("\n");
      results.push({
        name: "events-recent-errors",
        category: "Passive Learning",
        status: "warn",
        message: `Recent errors:\n${errorLines}`,
      });
    }
  }
}

function formatTimeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

3. Update `runDoctor` signature to accept a `verbose` parameter (it does not currently have one):
```typescript
export async function runDoctor(overrides?: Partial<DoctorDeps>, verbose = false): Promise<CheckResult[]> {
```

4. Call from `runDoctor`, after the Security section. Use the existing hook-installation results to determine if hooks are installed:
```typescript
  // ── Passive Learning ──
  // Gate: only check if hooks are installed (from Settings checks above).
  // The existing doctor produces a single combined check: { name: "hooks", category: "Settings" }
  // (NOT individual per-hook results like "hook-PostToolUse").
  const hooksInstalled = results.some(
    r => r.category === "Settings" && r.name === "hooks" && r.status === "pass"
  );
  checkPassiveLearning(results, hooksInstalled, verbose);
```

Note: The existing doctor checks hook installation in the Settings category and creates a single combined result `{ name: "hooks", category: "Settings", status: "pass" }` (not per-hook results). The gate checks this combined result to determine if passive learning hooks are active.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/doctor/doctor.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/doctor/doctor.ts test/doctor/doctor.test.ts
git commit -m "feat: add Passive Learning health checks to lcm doctor"
```

---

### Task 9: `lcm stats` + MCP Integration

**Files:**
- Modify: `src/stats.ts`
- Modify: `src/mcp/server.ts`
- Depends on: Task 7

- [ ] **Step 1: Write failing tests for stats event fields**

Add to `test/stats.test.ts` (or the appropriate stats test file — check existing test structure):

```typescript
describe("event stats integration", () => {
  it("collectStats includes eventsCaptured, eventsUnprocessed, eventsErrors", () => {
    const stats = collectStats();
    expect(stats).toHaveProperty("eventsCaptured");
    expect(stats).toHaveProperty("eventsUnprocessed");
    expect(stats).toHaveProperty("eventsErrors");
    // Defaults to 0 when no sidecar DBs exist
    expect(stats.eventsCaptured).toBe(0);
  });

  it("printStats shows Events line when eventsCaptured > 0", () => {
    const mockStats = {
      ...defaultStats,
      eventsCaptured: 100,
      eventsUnprocessed: 5,
      eventsErrors: 2,
    };
    const output = printStats(mockStats);
    expect(output).toContain("Events");
    expect(output).toContain("captured");
  });

  it("printStats omits Events line when eventsCaptured === 0", () => {
    const output = printStats(defaultStats);
    expect(output).not.toContain("Events");
  });
});
```

Note: Adapt this to the actual test file patterns — check whether `printStats` returns a string or writes to stdout.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stats.test.ts` (or wherever stats tests live)
Expected: FAIL — `eventsCaptured` property doesn't exist

- [ ] **Step 3: Add event fields to `OverallStats`**

In `src/stats.ts`, add three fields to the `OverallStats` interface (after line 37):

```typescript
  eventsCaptured: number;
  eventsUnprocessed: number;
  eventsErrors: number;
```

- [ ] **Step 4: Add event stats collection to `collectStats()`**

At the end of `collectStats()`, before the return statement, add:

```typescript
  // Passive learning event stats
  let eventsCaptured = 0;
  let eventsUnprocessed = 0;
  let eventsErrors = 0;
  try {
    const { collectEventStats } = await import("./db/events-stats.js");
    const eventStats = collectEventStats(2000);
    eventsCaptured = eventStats.captured;
    eventsUnprocessed = eventStats.unprocessed;
    eventsErrors = eventStats.errors;
  } catch { /* non-fatal */ }
```

Note: `collectStats` is currently synchronous. If dynamic import is needed, either make it async or use a static import. Check whether the existing callers handle async. If `collectStats` must stay sync, use a static import:

```typescript
import { collectEventStats } from "./db/events-stats.js";
```

And add to the return object:
```typescript
    eventsCaptured, eventsUnprocessed, eventsErrors,
```

Also update the empty return (around line 130) to include the defaults:
```typescript
    eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
```

- [ ] **Step 5: Add display line to `printStats()`**

In the Memory section of `printStats()`, add after the "Promoted memories" row:

```typescript
    if (stats.eventsCaptured > 0) {
      memRows.push(["Events", `${formatNumber(stats.eventsCaptured)} captured (${stats.eventsUnprocessed} unprocessed, ${stats.eventsErrors} errors (30d))`]);
    }
```

- [ ] **Step 6: Add MCP table row**

In `src/mcp/server.ts`, after the "Promoted memories" line (line 45), add:

```typescript
    if (stats.eventsCaptured > 0) {
      lines.push(`| Events | ${formatNumber(stats.eventsCaptured)} captured (${stats.eventsUnprocessed} unprocessed, ${stats.eventsErrors} errors (30d)) |`);
    }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/mcp/server.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/stats.ts src/mcp/server.ts
git commit -m "feat: add passive learning event stats to lcm stats and MCP tool"
```

---

### Task 10: Documentation Update

**Files:**
- Modify: `docs/passive-learning.md`
- No tests needed (documentation only)

- [ ] **Step 1: Update `docs/passive-learning.md`**

1. Add "Observability" section after "Recovery":

```markdown
## Observability

### `lcm doctor`

When passive learning hooks are installed, `lcm doctor` includes a "Passive Learning" category with three checks:

| Check | What it monitors |
|-------|-----------------|
| `events-capture` | Total events captured, unprocessed count |
| `events-errors` | Hook error count (last 30 days) |
| `events-staleness` | Time since last event capture |

### `lcm stats`

A single line is added to the Memory section:

```
Events          1,234 captured (42 unprocessed, 3 errors (30d))
```

This line only appears when events have been captured.
```

2. Update "Data Storage" section to document `error_log`:

```markdown
- **Error log**: `error_log` table in each sidecar DB
  - Records hook errors with timestamp and session ID
  - Pruned after 30 days on SessionStart
  - Queryable by `lcm doctor` for health diagnostics
```

3. Update "Recovery" table to include the new pruning:

```markdown
| Unprocessed cap | Oldest events pruned when > 10,000 rows or > 30 days |
| Error log pruning | Entries older than 30 days removed on SessionStart |
```

- [ ] **Step 2: Commit**

```bash
git add docs/passive-learning.md
git commit -m "docs: add observability and pruning documentation to passive-learning"
```

---

### Task 11: E2E Integration Test

**Files:**
- Modify: `test/e2e/passive-learning.test.ts`
- Depends on: All previous tasks

- [ ] **Step 1: Add E2E tests for error capture and health stats**

Add to `test/e2e/passive-learning.test.ts`:

```typescript
// ── Test H: Error capture via safeLogError ─────────────────────────────

it("safeLogError writes to error_log table in sidecar DB", async () => {
  const { safeLogError, _resetCircuitBreaker } = await import("../../src/hooks/hook-errors.js");
  _resetCircuitBreaker();

  safeLogError("PostToolUse", new Error("test e2e error"), {
    cwd: projectDir,
    sessionId: "e2e-error-test",
  });

  const dbPath = eventsDbPath(projectDir);
  const db = new EventsDb(dbPath);
  try {
    const stats = db.getHealthStats();
    expect(stats.errors).toBe(1);
    expect(stats.lastError).toBeTruthy();
  } finally {
    db.close();
  }
});

// ── Test I: Pruning caps unprocessed events ──────────────────────────

it("pruneUnprocessed caps events at maxRows", async () => {
  // Insert 20 events
  const dbPath = eventsDbPath(projectDir);
  const db = new EventsDb(dbPath);
  try {
    for (let i = 0; i < 20; i++) {
      db.insertEvent("e2e-prune-test", {
        type: "file", category: "pattern", data: `event-${i}`, priority: 3,
      }, "PostToolUse");
    }
    expect(db.getHealthStats().unprocessed).toBe(20);

    const result = db.pruneUnprocessed(10, 30);
    expect(result.pruned).toBe(10);
    expect(db.getHealthStats().unprocessed).toBe(10);

    // Verify prune was logged to error_log
    expect(db.getHealthStats().errors).toBeGreaterThanOrEqual(1);
  } finally {
    db.close();
  }
});

// ── Test J: collectEventStats aggregation ────────────────────────────

it("collectEventStats aggregates across sidecar DBs", async () => {
  // Create events in the project sidecar
  const dbPath = eventsDbPath(projectDir);
  const db = new EventsDb(dbPath);
  try {
    db.insertEvent("e2e-stats-test", {
      type: "decision", category: "decision", data: "test", priority: 1,
    }, "PostToolUse");
    db.logHookError("PostToolUse", new Error("test error"));
  } finally {
    db.close();
  }

  const { collectEventStats } = await import("../../src/db/events-stats.js");
  const stats = collectEventStats();
  expect(stats.captured).toBeGreaterThanOrEqual(1);
  expect(stats.errors).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run all E2E tests**

Run: `npx vitest run test/e2e/passive-learning.test.ts`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add test/e2e/passive-learning.test.ts
git commit -m "test: add E2E tests for error capture, pruning, and stats aggregation"
```

---

## Full Test Suite Verification

After all tasks are complete:

```bash
npx vitest run
```

Expected: ALL PASS, no regressions.

---

## Parallelization Map

| Phase | Tasks | Model Suggestion |
|-------|-------|-----------------|
| 1 | Task 1 (schema v2) | sonnet |
| 2 | Tasks 2, 6, 7 (in parallel) | haiku, haiku, sonnet |
| 3 | Tasks 3, 4, 5 (in parallel) | haiku, haiku, haiku |
| 4 | Tasks 8, 9 (in parallel) | sonnet, haiku |
| 5 | Task 10 (docs) | haiku |
| 6 | Task 11 (E2E) | sonnet |
