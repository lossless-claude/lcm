# P0 Hardening: Observability + Event Cap for Passive Learning

**Issues:** [#129](https://github.com/lossless-claude/lcm/issues/129) (observability), [#130](https://github.com/lossless-claude/lcm/issues/130) (event cap)

**Goal:** Make the passive learning pipeline observable and bounded — errors are queryable, unprocessed events are capped, and `lcm doctor` / `lcm stats` surface pipeline health.

**Scope:** Both issues share the same files and the same concern (what happens when things go wrong). They are designed as a single spec.

---

## 1. Sidecar Schema: `error_log` Table + Pruning

### 1.1 Schema Migration

Bump `SCHEMA_VERSION` from 1 to 2 in `src/hooks/events-db.ts`. The migration adds one table and one index:

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

**Migration safety:** Wrap only the v1→v2 upgrade branch in `BEGIN EXCLUSIVE` / `COMMIT` — not the entire `migrate()` body. On fresh install (no `schema_version` table), the existing code path runs `CREATE TABLE IF NOT EXISTS` which is safe without exclusive locking. The exclusive transaction is only needed for the upgrade path where two concurrent hooks might both read VERSION=1 and race to create the new table. WAL mode + `busy_timeout = 5000` handles contention gracefully.

### 1.2 New `EventsDb` Methods

```typescript
logHookError(hook: string, error: unknown, sessionId?: string): void
// INSERT INTO error_log (hook, error, session_id) VALUES (?, ?, ?)

pruneUnprocessed(maxRows = 10_000, maxAgeDays = 30): { pruned: number }
// DELETE oldest by event_id when count > maxRows
// DELETE by event_id where created_at < now - maxAgeDays
// Log prune count to error_log BEFORE deleting: "pruned N unprocessed events (cap exceeded)"
// Uses event_id for ordering (monotonic ROWID), matching getUnprocessed() implicit order

getHealthStats(): HealthStats
// Returns: { totalEvents, unprocessed, errors, lastCapture, lastError }
// Single pass: 3 COUNT/MAX queries against indexed columns

pruneErrorLog(olderThanDays = 30): number
// DELETE FROM error_log WHERE created_at < datetime('now', '-' || ? || ' days')
```

**Prune ordering:** Both `pruneUnprocessed` and `getUnprocessed` use `event_id` (monotonic ROWID) to avoid clock-skew divergence between the batch cursor and the prune cursor.

**Prune triggers:** `pruneUnprocessed()` and `pruneErrorLog()` are called on SessionStart alongside existing `pruneProcessed(7)`.

### 1.3 HealthStats Interface

```typescript
interface HealthStats {
  totalEvents: number;
  unprocessed: number;
  errors: number;        // error_log count (last 30 days)
  lastCapture: string | null;  // ISO timestamp of most recent event
  lastError: string | null;    // ISO timestamp of most recent error_log entry
}
```

---

## 2. Unified Error Flow: `safeLogError()`

### 2.1 Problem

Three files handle errors three different ways:

| File | Current Pattern | Problem |
|------|----------------|---------|
| `post-tool.ts` | `logError()` → flat file | Not queryable |
| `user-prompt.ts` | bare `catch {}` | Completely silent |
| `promote-events.ts` | `result.errors++` | Lost after HTTP response |

### 2.2 Three-Layer Fence

New utility function in `src/hooks/hook-errors.ts`:

```typescript
let dbCircuitOpen = false; // process-level circuit breaker

export function safeLogError(
  hook: string,
  error: unknown,
  opts: { cwd?: string; sessionId?: string }
): void {
  // Layer 1: Sidecar DB (skip if cwd missing or circuit open)
  if (opts.cwd && !dbCircuitOpen) {
    try {
      const db = new EventsDb(eventsDbPath(opts.cwd));
      try { db.logHookError(hook, error, opts.sessionId); }
      finally { db.close(); }
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

### 2.3 Changes Per File

- **`post-tool.ts`**: Replace local `logError()` with `safeLogError()`. Remove the `logError` function and `LOG_PATH` constant (moved to `hook-errors.ts`).
- **`user-prompt.ts`**: Replace bare `catch {}` in sidecar extraction with `catch (e) { safeLogError("UserPromptSubmit", e, { cwd, sessionId: input.session_id }) }`.
- **`promote-events.ts`**: Add `safeLogError("promote-events", error, { cwd, sessionId: event.session_id })` **alongside** existing `result.errors++`. The counter is the synchronous HTTP signal; the DB log is for async forensics. Both must exist.

### 2.4 Design Constraints

- **Own connection per error:** `safeLogError` opens its own DB connection because the caller's connection may be the failure surface. One extra open/close per error is acceptable on the exception path.
- **Circuit breaker:** After first Layer 1 failure, a module-level flag skips DB attempts for the remainder of the process lifetime. Prevents repeated latency on persistent DB failures.
- **cwd guard:** If `opts.cwd` is undefined, Layer 1 is skipped entirely — no garbage paths from `eventsDbPath(undefined)`.

---

## 3. `lcm doctor` Integration

### 3.1 New Category: "Passive Learning"

Add `checkPassiveLearning(results: CheckResult[])` to `src/doctor/doctor.ts`.

**Gate:** If the PostToolUse hook is not installed (already checked in Settings category), skip the entire Passive Learning section. No false positives for users without passive learning.

### 3.2 Checks

| Check Name | Condition | Status | Message |
|-----------|-----------|--------|---------|
| `events-capture` | Hooks installed, sidecar DBs found | **pass** | "1,234 events across 3 projects (42 unprocessed)" |
| `events-capture` | Hooks installed, no sidecar DBs | **warn** | "No events captured — passive learning may not be active" |
| `events-capture` | Unprocessed > 1,000 | **warn** | "2,847 unprocessed — daemon may be offline. Fix: lcm daemon start" |
| `events-errors` | 0 errors | **pass** | "0 hook errors" |
| `events-errors` | 1-49 errors | **warn** | "12 hook errors (30d). Run: lcm doctor --verbose" |
| `events-errors` | >= 50 errors | **fail** | "187 hook errors (30d) — check ~/.lossless-claude/logs/events.log" |
| `events-staleness` | Last capture < 7 days | **pass** | "last capture 2m ago" |
| `events-staleness` | Last capture >= 7 days | **warn** | "last capture 12d ago — hooks may not be firing if project is active" |

### 3.3 Scanning Constraints

- **Serial scan** of `~/.lossless-claude/events/*.db`
- **Per-DB timeout:** 500ms (SQLite `busy_timeout`)
- **DB cap:** 50 DBs max, with "...and N more not checked" notice if exceeded
- **Per-DB error isolation:** One corrupt DB does not abort the entire check
- **Read-only:** `getHealthStats()` queries only, no test writes

### 3.4 Verbose Mode

`checkPassiveLearning` accepts a `verbose: boolean` parameter. When `false`, it pushes only the summary `CheckResult` entries. When `true`, it additionally pushes per-project `CheckResult` entries and appends the last 5 error_log entries to the `events-errors` message. The existing `runDoctor` function already threads a `verbose` flag through to `printStats()`; this parameter follows the same pattern.

When `--verbose` is passed, show per-project breakdown:

```
    Passive Learning
      project-abc     234 events (12 unprocessed)  last: 2m ago
      project-xyz     1,000 events (30 unprocessed)  last: 1h ago
      errors (last 5):
        2026-03-25 PostToolUse: SQLITE_BUSY database is locked
        2026-03-24 promote-events: Connection refused
```

---

## 4. `lcm stats` Integration

### 4.1 New Fields on `OverallStats`

```typescript
eventsCaptured: number;     // total events across all sidecar DBs
eventsUnprocessed: number;  // total unprocessed (waiting for promotion)
eventsErrors: number;       // total error_log entries (last 30 days)
```

Default to 0 when no sidecar DBs exist.

### 4.2 Data Collection

Extract sidecar scanning into `src/db/events-stats.ts` (neutral layer):

```typescript
// src/db/events-stats.ts
export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
}

export function collectEventStats(timeoutMs = 2000): EventStats
// Scans eventsDir() for *.db files
// Opens each with EventsDb, calls getHealthStats(), closes
// Serial scan with aggregate 2-second timeout budget
// Cap at 50 DBs — stop early if budget exceeded
// Returns aggregated counts
```

Both `stats.ts` and `doctor.ts` import from this neutral layer. No direct `hooks/` dependency from core modules.

### 4.3 Display

Single line in the Memory section of `printStats()`:

```
    Events          1,234 captured (42 unprocessed, 3 errors (30d))
```

- Omit the line entirely if `eventsCaptured === 0` (no noise for non-passive-learning users)
- Include `(30d)` suffix on errors to make the rolling window explicit

### 4.4 MCP Tool

Add one row to `lcm_stats` markdown table output:

```
| Events | 1,234 captured (42 unprocessed, 3 errors (30d)) |
```

---

## 5. Documentation

Update `docs/passive-learning.md`:

- Add "Observability" section describing doctor checks and stats integration
- Update "Recovery" table with new pruning behavior
- Document the error_log table in "Data Storage" section
- Remove any claims about event counters that were previously aspirational

---

## 6. Testing Strategy

### Unit Tests

- `events-db.test.ts`: Test `logHookError`, `pruneUnprocessed` (row cap, age cap, **explicit test that prune count is logged to error_log before deletion**), `getHealthStats`, `pruneErrorLog`, schema migration v1→v2
- `hook-errors.test.ts`: Test `safeLogError` three-layer fence (DB success, DB fail → file, both fail → swallow), circuit breaker behavior, cwd guard
- `events-stats.test.ts`: Test `collectEventStats` aggregation, timeout budget, empty directory

### Integration Tests

- `doctor.test.ts`: Add passive learning check tests (pass/warn/fail states, hook-not-installed gate, corrupt DB isolation)
- `post-tool.test.ts`: Verify `safeLogError` is called on errors
- `user-prompt.test.ts`: Verify sidecar catch block uses `safeLogError`

### E2E Tests

- Extend `passive-learning.test.ts`: Full cycle including error capture, pruning, doctor check, stats output

---

## 7. Files Changed

| File | Change Type | Description |
|------|------------|-------------|
| `src/hooks/events-db.ts` | Modify | Schema v2 migration, 4 new methods |
| `src/hooks/hook-errors.ts` | **New** | `safeLogError()` three-layer fence |
| `src/hooks/post-tool.ts` | Modify | Replace `logError` with `safeLogError` |
| `src/hooks/user-prompt.ts` | Modify | Replace bare catch with `safeLogError` |
| `src/hooks/restore.ts` | Modify | Add `pruneUnprocessed` + `pruneErrorLog` calls |
| `src/daemon/routes/promote-events.ts` | Modify | Add `safeLogError` alongside `result.errors++` |
| `src/db/events-stats.ts` | **New** | Shared sidecar scan for stats + doctor |
| `src/doctor/doctor.ts` | Modify | Add "Passive Learning" category |
| `src/stats.ts` | Modify | Add event fields + display line |
| `src/mcp/server.ts` | Modify | Add events row to `lcm_stats` output |
| `docs/passive-learning.md` | Modify | Add observability + pruning docs |
| `test/hooks/events-db.test.ts` | Modify | New method tests |
| `test/hooks/hook-errors.test.ts` | **New** | Three-layer fence tests |
| `test/db/events-stats.test.ts` | **New** | Scan + aggregation tests |
| `test/doctor/doctor.test.ts` | Modify | Passive learning check tests |

---

## 8. Non-Goals

- **Configurable thresholds** — Hardcoded defaults are reasonable for now. Configurability is a future enhancement.
- **Connection pooling** (#131) — Separate P1 issue, orthogonal to observability.
- **Real-time alerting** — Doctor is run on-demand, not continuously.
- **Stderr warnings during hooks** — Hooks must be silent to avoid interfering with Claude Code's hook protocol. Error signal is captured, not displayed.

---

## 9. Adversarial Review Summary

Design was evaluated by persistent FOR and AGAINST agents across all 4 sections:

| Section | FOR Score | AGAINST Score | Key Refinements |
|---------|-----------|---------------|-----------------|
| 1. Schema | 8.5/10 | 7/10 | Index on error_log, exclusive migration transaction, prune logging before deletion, event_id ordering |
| 2. Error flow | 8/10 | 6/10 | cwd guard, circuit breaker, keep result.errors++, include cwd in flat-file |
| 3. Doctor | 8.5/10 | 6/10 | Hook-installed gate, 7-day staleness (not 24h), per-DB timeout, 50-DB cap |
| 4. Stats | 9/10 | 6/10 | events-stats.ts neutral layer, 2s total timeout, "(30d)" error label |
