# Copilot Review Instructions — lossless-claude (lcm)

This repo is a TypeScript SQLite daemon that persists Claude session memories across context resets. It uses Node.js `DatabaseSync` (synchronous SQLite API) and exposes an HTTP daemon with REST routes.

## Primary concerns

### Database connection pattern (highest priority)
- All SQLite access MUST use `getLcmConnection()` and `closeLcmConnection()` from the shared connection module. Flag any `new DatabaseSync(...)` instantiated directly in route handlers or utility files.
- The shared connection ensures WAL mode and foreign key enforcement are set once at open time.
- Flag double-open patterns: calling `getLcmConnection()` without a corresponding `closeLcmConnection()` on all exit paths.

### PRAGMA enforcement
- If a new connection is ever opened directly (e.g., in migration scripts), it must immediately set:
  - `PRAGMA journal_mode=WAL`
  - `PRAGMA foreign_keys=ON`
- Flag connections missing these PRAGMAs.

### Type safety
- No implicit `any`. All function parameters, return types, and object shapes must be explicitly typed.
- Flag `as any` casts unless accompanied by a comment explaining why it's necessary.
- Route handler request/response objects must use typed interfaces, not `any`.

### `collectStats()` performance
- `collectStats()` takes ~13 seconds due to full-table scans. It must NEVER be called in:
  - HTTP request handlers
  - Any path that runs more than once per user action
  - Startup initialization (lazy evaluation only)
- Flag any `collectStats()` call that isn't in a dedicated stats endpoint or background job.

### Test coverage
- New HTTP routes must have corresponding tests in `test/daemon/routes/`.
- Tests should cover: happy path, missing required fields (400), and resource-not-found (404).
- Flag PRs adding routes without tests.

### SQLite transaction safety
- Any operation that modifies more than one table must be wrapped in `BEGIN`/`COMMIT`.
- Flag multi-table writes without transactions — they risk partial writes on crash.

### Migration safety
- Schema migrations must be additive only: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`.
- Flag `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN type`, or any destructive DDL.
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### Error handling
- Route handlers must catch errors and return structured JSON: `{ error: string, code?: string }`.
- Flag `res.send(e.message)` or unstructured error responses that leak stack traces.
- Unhandled promise rejections in route handlers are bugs — flag missing `try/catch` in `async` handlers.

## What to skip
- Don't flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Don't flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
