# Copilot Review Instructions — lcm

<!-- review-checklist:start — generated from .github/review-checklist.md by scripts/sync-review-checklist.mjs; edit the source -->

## Repository context

TypeScript SQLite daemon that persists Claude session memories across context resets. Uses Node.js `DatabaseSync` (synchronous SQLite API from `node:sqlite`) and exposes an HTTP daemon with REST routes.

## codebase-memory MCP: query the graph first

A `codebase-memory` MCP server is running with a prebuilt graph of this repo. Use it before any text search or file view; built-in grep/regex search and line-range file reads are fallbacks, not the starting point.

Do this, in order, before reading any diff hunk:

1. `list_projects`: the project name comes from the checkout path; never guess it.
2. For every changed exported function, class, route or schema column, `search_graph` to locate it and `trace_path` to list its callers and callees. `trace_path` is what settles "does anything else depend on this?"; do not claim that nothing else depends on a symbol without it.
3. `get_code_snippet` for the source you need; `query_graph` for multi-hop questions; `get_architecture` for orientation.

`search_code` only for literal or non-code text, or where graph coverage is thin. Fall back to built-in search only when a graph call errors, and say so.

Rules that are unreliable without the graph: **#1** (a caller may own the close), **#4** (`collectStats()` is often reached indirectly), **#5** (existing tests live outside the diff), **#10** (whether a named symbol still exists).

The review body opens with a short "Graph calls" list naming the tools used and the symbols traced; a review without that list is incomplete. Cite what you looked up: "nothing else calls this" is not reviewable unless you say how you checked.

Before reporting a review finding as fixed, verify it against the graph. Editing the file a finding points at is not the same as closing it. State which findings you verified and how.

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

- `collectStats()` runs full-table scans, so its cost grows with the database. It must NEVER be called in:
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

- Daemon HTTP requests must send the `Authorization: Bearer <token>` header; the token is read via `readAuthToken(join(homedir(), ".lossless-claude", "daemon.token"))`. Auth is mandatory; a 401 arrives as a normal HTTP response, not a socket error — flag client code paths that drop the header or mishandle 401s.
- `DaemonClient` throws `Error` objects annotated with the HTTP status and parsed JSON body (`e.status`, `e.body`) on non-2xx responses — flag client code that swallows non-2xx responses or loses the status/body annotations.

### 10. Source references in prose

- Point at **symbols**, not line numbers: `CompactionEngine.persistCompactionEvent`, not `src/compaction.ts:1331`. Line numbers rot on any edit above them, and a stale one still looks plausible; a renamed symbol is greppable.
- Flag any `path/to/file.ts:NNN` in Markdown, doc comments, or commit messages, unless pinned to an immutable ref (a commit SHA, or a labelled review-finding identifier).
- Applies to `docs/`, `docs/design/`, `AGENTS.md`, and skill files.

## What to skip

- Do not flag `DatabaseSync` usage in test fixtures that mock the connection — context matters.
- Do not flag TypeScript-specific patterns that are idiomatic (e.g., discriminated unions, assertion functions).
- Do not flag style preferences already covered by the formatter/linter.

<!-- review-checklist:end -->
