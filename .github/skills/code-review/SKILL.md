---
name: code-review
description: Review code changes in the lossless-claude/lcm repository. Use when asked to review a PR, diff, or code change. Encodes project-specific rules for the SQLite daemon, connection lifecycle, type safety, performance gates, test coverage, transactions, migrations, and error handling.
---

# lcm Code Review

Review code changes in this repository against the project rules below. These rules exist because they have caused real production bugs — flag violations with high confidence.

## Repository context

TypeScript SQLite daemon that persists Claude session memories across context resets. Uses Node.js `DatabaseSync` (synchronous SQLite API from `node:sqlite`) and exposes an HTTP daemon with REST routes.

## Review checklist

### 1. Database connection pattern (highest priority)

- All SQLite access MUST use `getLcmConnection()` and `closeLcmConnection()` from the shared connection module.
- Flag any `new DatabaseSync(...)` instantiated directly in route handlers or utility files.
- The shared connection ensures WAL mode and foreign key enforcement are set once at open time.
- Flag double-open patterns: calling `getLcmConnection()` without a corresponding `closeLcmConnection()` on all exit paths (including error paths).

### 2. PRAGMA enforcement

- If a new connection is ever opened directly (e.g., in migration scripts), it must immediately set:
  - `PRAGMA journal_mode=WAL`
  - `PRAGMA foreign_keys=ON`
- Flag connections missing these PRAGMAs.

### 3. Type safety

- No implicit `any`. All function parameters, return types, and object shapes must be explicitly typed.
- Flag `as any` casts unless accompanied by a comment explaining why it is necessary.
- Route handler request/response objects must use typed interfaces, not `any`.
- TypeScript conventions: `node:` prefix for Node.js built-in imports, `import type { ... }` for type-only imports, ESM-style imports with `.js` extensions in TS files.

### 4. `collectStats()` performance

- `collectStats()` takes ~13 seconds due to full-table scans. It must NEVER be called in:
  - HTTP request handlers
  - Any path that runs more than once per user action
  - Startup initialization (lazy evaluation only)
- Flag any `collectStats()` call that is not in a dedicated stats endpoint or background job.
- When a response stops using queried data on a code path, the associated reads and read-only connection setup must be gated to paths that still consume them; required capture writes must be preserved.

### 5. Test coverage

- New HTTP routes must have corresponding tests in `test/daemon/routes/`.
- Tests should cover: happy path, missing required fields (400), and resource-not-found (404).
- Flag PRs adding routes without tests.

### 6. SQLite transaction safety

- Any operation that modifies more than one table must be wrapped in `BEGIN`/`COMMIT`.
- Flag multi-table writes without transactions — they risk partial writes on crash.

### 7. Migration safety

- Schema migrations must be additive only: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`.
- Flag `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN type`, or any destructive DDL.
- Migrations must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### 8. Error handling

- Route handlers must catch errors and return structured JSON: `{ error: string, code?: string }`.
- Flag `res.send(e.message)` or unstructured error responses that leak stack traces.
- Unhandled promise rejections in route handlers are bugs — flag missing `try/catch` in `async` handlers.

### 9. Daemon client conventions

- Daemon HTTP requests must send the `Authorization: ******` header; the token is read via `readAuthToken(join(homedir(), ".lossless-claude", "daemon.token"))`. Auth is mandatory; a 401 arrives as a normal HTTP response, not a socket error — flag client code paths that drop the header or mishandle 401s.
- `DaemonClient` throws `Error` objects annotated with the HTTP status and parsed JSON body (`e.status`, `e.body`) on non-2xx responses — flag client code that swallows non-2xx responses or loses the status/body annotations.

### 10. Source references in docs and comments

- Prose that points at code must name **symbols**, not line numbers: `CompactionEngine.persistCompactionEvent`, not `src/compaction.ts:1331`. Line numbers rot on any edit above them — nobody has to touch the described code for the reference to go stale, and the stale number still looks plausible. A renamed symbol is greppable; a wrong line number is silent.
- Flag any `path/to/file.ts:NNN` in Markdown, in a doc comment, or in a commit message, unless it is pinned to an immutable ref (a commit SHA, or an explicitly labelled review-finding identifier).
- This applies to `.xgh/specs/`, `.xgh/plans/`, `docs/`, `AGENTS.md`, and skill files — anywhere a reader may follow the reference against a branch other than the one it was written on.

## What to skip

- Do not flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Do not flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
- Do not flag style preferences already covered by the formatter/linter.
