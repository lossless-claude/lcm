# SP4 Stretch Goal #4 — LCM Pool Stats

**Status:** Complete
**Branch:** fix/issue-162-post-tool-cli-command (add as separate commit)

## What was built

### 1. `src/db/connection.ts` — `getPoolStats()`
Exports a new `PoolStats` interface and `getPoolStats()` function that snapshots the in-memory `_connections` Map:
- `totalConnections` — total open handles
- `activeConnections` — handles with refs > 0
- `idleConnections` — handles with refs == 0 (shouldn't exist in normal operation since close removes them, but included for completeness)
- `connections[]` — per-connection detail: `{ path, refs, status }`

### 2. `src/daemon/routes/pool-stats.ts` — `GET /stats/pool`
Thin route handler that calls `getPoolStats()` and returns JSON. Registered in `server.ts` as `GET /stats/pool`.

### 3. `bin/lcm.ts` — `lcm stats --pool`
Added two new options to the `stats` command:
- `--pool` — fetch and display pool metrics from the daemon
- `--json` — output raw JSON (usable with `--pool` for scripting)

Human-readable output shows a summary table (Total/Active/Idle) plus per-connection detail lines.

## Files changed
- `src/db/connection.ts` — added `PoolStats` interface + `getPoolStats()` export
- `src/daemon/routes/pool-stats.ts` — new file
- `src/daemon/server.ts` — import + route registration
- `bin/lcm.ts` — `--pool` / `--json` flags on `stats` command

## New tests (10 total, all passing)
- `test/db/connection.test.ts` (6 unit tests) — pool state tracking across open/close/multi-connection scenarios
- `test/daemon/routes/pool-stats.test.ts` (4 integration tests) — route shape, non-negative counts, per-entry fields, sum invariant

## Test run result
- 88 test files pass, 746 tests pass
- 1 pre-existing failure in `test/daemon/routes/restore.test.ts` — environmental: CLAUDE.md global instructions contain `<project-instructions>` which leaks into context during test. Unrelated to this change (was failing before, confirmed via git stash).

## Design decisions
- Snapshot stats (not time-series) — sufficient at current scale per SP4 idea matrix
- `GET` (not `POST`) for the pool stats endpoint — read-only, idempotent, no body needed
- Auth is still required (standard daemon auth applies via server.ts middleware)
- `--json` flag added alongside `--pool` to match pattern from `lcm status --json`
