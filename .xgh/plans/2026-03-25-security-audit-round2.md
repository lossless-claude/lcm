# Security Audit Report — Round 2 (New Findings)

**Date:** 2026-03-25
**Auditor:** Claude Opus 4.6
**Scope:** All subsystems NOT covered by PR #89 / existing hardening plan
**Codebase:** lossless-claude @ `develop` branch (commit 951b57a)

---

## Critical

*No critical findings.*

---

## High

### SEC-NEW-1 — HTTP request body has no size limit (DoS)

- **Severity:** High
- **Subsystem:** Daemon server
- **Location:** `src/daemon/server.ts:34-37`
- **Description:** The `readBody()` function reads the entire request body into memory with no size cap. An attacker (or misbehaving client) on localhost can POST a multi-GB payload to any route, causing the daemon to OOM-crash. Since the daemon is a singleton long-lived process, this kills all active sessions.
- **Proof:**
  ```typescript
  export async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return Buffer.concat(chunks).toString("utf-8");
  }
  ```
- **Recommendation:** Add a configurable `maxBodyBytes` limit (e.g., 10 MB). Abort the request with 413 Payload Too Large if exceeded:
  ```typescript
  const MAX_BODY = 10 * 1024 * 1024;
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) { res.writeHead(413); res.end(); return ""; }
    chunks.push(...);
  }
  ```

---

### SEC-NEW-2 — MCP server passes tool arguments to daemon with no validation

- **Severity:** High
- **Subsystem:** MCP server
- **Location:** `src/mcp/server.ts:129-137`
- **Description:** The `CallToolRequestSchema` handler forwards `req.params.arguments` directly to the daemon HTTP API with no input validation or type checking. The MCP protocol defines `inputSchema` on each tool, but the SDK does not enforce it at runtime — the server trusts the caller. A compromised or malicious MCP client can inject arbitrary keys into daemon route payloads (e.g., smuggle `session_id`, `transcript_path`, or `cwd` overrides).
- **Proof:**
  ```typescript
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // ...
    const route = TOOL_ROUTES[req.params.name];
    if (!route) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await client.post(route, { ...req.params.arguments, cwd: process.env.PWD ?? process.cwd() });
  });
  ```
  Note: `...req.params.arguments` is spread first, then `cwd` is appended — but if the caller supplies `cwd` in arguments, the spread places it and then it gets overwritten. However, any other arbitrary keys (`session_id`, `skip_ingest`, `client`, etc.) pass through to the daemon route handler unfiltered.
- **Recommendation:** Validate arguments against each tool's `inputSchema` before forwarding. Extract only the documented parameters for each tool. Use a schema validation library (e.g., `@sinclair/typebox` which is already a dependency) to enforce the schema at the MCP layer.

---

### SEC-NEW-3 — Promotion detector executes config-sourced regex without ReDoS protection

- **Severity:** High
- **Subsystem:** Promotion detector
- **Location:** `src/promotion/detector.ts:30`
- **Description:** `shouldPromote()` iterates over `thresholds.architecturePatterns` (sourced from `config.json`) and constructs a `new RegExp(pattern)` for each, tested against potentially large summary content. The config file is user-editable — a user (or a tool that modifies config) could introduce a catastrophic backtracking pattern (e.g., `(a+)+$`). Unlike the search-path ReDoS finding (#4 in the existing plan), this vector is in the promotion pipeline which runs on every compaction cycle.
- **Proof:**
  ```typescript
  for (const pattern of thresholds.architecturePatterns) {
    if (new RegExp(pattern).test(content)) { tags.push("architecture"); break; }
  }
  ```
  The default patterns in `config.ts` are safe (`"src/[\\w/]+\\.ts"`, etc.), but there is no validation when loading custom patterns from `config.json`.
- **Recommendation:** Validate `architecturePatterns` at config load time using `safe-regex` (already being added per the existing plan). Reject or warn on patterns that fail the safety check.

---

## Medium

### SEC-NEW-4 — `cwd` parameter accepted without canonicalization across all daemon routes

- **Severity:** Medium
- **Subsystem:** All daemon routes
- **Location:** Multiple: `restore.ts`, `search.ts`, `recent.ts`, `status.ts`, `describe.ts`, `expand.ts`, `grep.ts`, `promote.ts`, `session-complete.ts`, `store.ts`
- **Description:** The `cwd` parameter from POST bodies is passed directly to `projectDbPath(cwd)` which hashes `cwd` via SHA-256 and uses it to locate the project database. While this prevents file-system path traversal (the hash is the directory name), a non-canonical `cwd` (e.g., with trailing slashes, `//`, `..` components, or symlinks) produces a different hash than the canonical path, allowing:
  1. **Phantom projects** — data written under a non-canonical path creates an orphan database that won't be found when querying with the canonical path.
  2. **Cross-project data access** — if a user can control `cwd`, they can point at any project's database by supplying the right path.
  Note: The existing plan covers `transcript_path` validation but NOT `cwd` canonicalization.
- **Proof:** `projectId()` in `src/daemon/project.ts` hashes the raw string:
  ```typescript
  export const projectId = (cwd: string): string =>
    createHash("sha256").update(cwd).digest("hex");
  ```
- **Recommendation:** Canonicalize `cwd` with `path.resolve()` and `fs.realpathSync()` at the top of every route handler (or in a shared middleware). Reject empty or non-absolute paths.

---

### SEC-NEW-5 — `store` route accepts arbitrary text without scrubbing

- **Severity:** Medium
- **Subsystem:** Store route
- **Location:** `src/daemon/routes/store.ts:10-30`
- **Description:** The `/store` route writes user-supplied `text` directly to the `promoted` SQLite table without running the ScrubEngine. This is noted in the existing plan as finding #8, BUT the existing plan only mentions "doesn't run ScrubEngine." This finding adds: the `tags` array and `metadata` object are also passed through unvalidated. Tags could contain arbitrary strings used later in FTS5 MATCH queries (the `search()` method in `PromotedStore` quotes terms, mitigating SQL injection, but storing attacker-controlled tags means they appear in search results and could be used for data poisoning).
- **Recommendation:** (Beyond just adding ScrubEngine): Validate `tags` as an array of short alphanumeric strings. Validate `metadata` keys against an allowlist. Cap `text` length.

---

### SEC-NEW-6 — Vulnerable transitive dependencies: `hono`, `@hono/node-server`, `rollup`

- **Severity:** Medium
- **Subsystem:** Dependency chain
- **Location:** `package.json` (transitive via `@modelcontextprotocol/sdk`)
- **Description:** `npm audit` reports 3 high-severity vulnerabilities:
  1. **`@hono/node-server` < 1.19.10** — Authorization bypass for protected static paths via encoded slashes (GHSA-wc8c-qw6v-h7f6)
  2. **`hono` < 4.12.4** — Multiple: cookie injection, SSE control field injection, arbitrary file access via `serveStatic`, prototype pollution via `parseBody({dot:true})` (4 advisories)
  3. **`rollup` 4.0.0-4.58.0** — Arbitrary file write via path traversal (GHSA-mw96-cpmx-2vgc)

  While `hono` is only used transitively through the MCP SDK (which uses it for the SSE transport), and `rollup` is dev-only (used by vitest), the hono vulnerabilities could be relevant if the MCP server ever switches to SSE/HTTP transport.
- **Recommendation:** Run `npm audit fix` or pin `@modelcontextprotocol/sdk` to a version that pulls in fixed `hono` >= 4.12.4. For rollup, update vitest or pin rollup >= 4.59.0.

---

### SEC-NEW-7 — Error messages leak internal state in daemon responses

- **Severity:** Medium
- **Subsystem:** All daemon routes
- **Location:** Multiple files (see error-responses grep above)
- **Description:** All daemon route catch blocks expose `err.message` directly in the JSON response:
  ```typescript
  sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  ```
  Node.js error messages can contain file paths, database schema details, SQL error text, and other internal state. For example, a SQLite error like `"SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.conversation_id, messages.ordinal"` reveals table/column structure. While the daemon is localhost-only, this is defense-in-depth and matters once auth is added (authenticated users shouldn't see internals).
- **Recommendation:** Log the full error server-side. Return a generic message to the client, or at minimum sanitize to remove file paths and SQL details. Consider an error code system.

---

### SEC-NEW-8 — Import pipeline follows symlinks without validation

- **Severity:** Medium
- **Subsystem:** Import pipeline
- **Location:** `src/import.ts:75-115`, `src/codex-transcript.ts:90-130`
- **Description:** Both `findSessionFiles()` and `findCodexSessionFiles()` use `readdirSync()` + `statSync()` to discover `.jsonl` files. `statSync()` follows symlinks by default — a symlink placed in `~/.claude/projects/<hash>/` pointing to an arbitrary file (e.g., `/etc/passwd`) would cause `lcm import` to read that file and attempt to parse it as a JSONL transcript, potentially sending its content to the daemon's `/ingest` endpoint. While the content must parse as valid JSONL messages to survive ingestion, the file IS read into memory.
  The code uses `entry.isFile()` from `readdirSync({withFileTypes: true})`, but `isFile()` on a symlink to a file returns `true`.
- **Proof:**
  ```typescript
  if (entry.isFile() && entry.name.endsWith('.jsonl')) {
    // ... statSync(join(projectDir, entry.name)) follows symlinks
  }
  ```
- **Recommendation:** Use `lstatSync()` instead of `statSync()` and skip entries where `lstat.isSymbolicLink()` is true. Or resolve symlinks and verify the target is within the expected directory tree.

---

### SEC-NEW-9 — Bootstrap flag files in `/tmp` allow cross-user interference

- **Severity:** Medium
- **Subsystem:** Bootstrap
- **Location:** `src/bootstrap.ts:55-60`
- **Description:** The bootstrap guard writes flag files to the shared `tmpdir()` directory: `${tmpdir()}/lcm-bootstrapped-${safeId}.flag`. On multi-user systems, another user could pre-create these flag files, preventing bootstrap from running for a victim user's session. The `safeSessionId` sanitization is good (strips non-alphanumeric), but the location is shared.
- **Proof:**
  ```typescript
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagPath = join(tmpdir(), `lcm-bootstrapped-${safeId}.flag`);
  ```
- **Recommendation:** Use a user-specific directory: `join(homedir(), ".lossless-claude", "tmp")` instead of `tmpdir()`. This also applies to snapshot cursor files in `session-snapshot.ts` (same pattern at `join(tmpdir(), \`lcm-snap-${safeSessionId}.json\`)`).

---

### SEC-NEW-10 — `readClaudeMdFiles` reads files relative to unvalidated `cwd`

- **Severity:** Medium
- **Subsystem:** Restore route
- **Location:** `src/daemon/routes/restore.ts:21-35`
- **Description:** The `readClaudeMdFiles(cwd)` function reads `CLAUDE.md` files from:
  - `~/.claude/CLAUDE.md` (fixed, safe)
  - `${cwd}/CLAUDE.md` (user-controlled)
  - `${cwd}/.claude/CLAUDE.md` (user-controlled)

  The `cwd` comes from the POST body without validation. An attacker could set `cwd` to `/etc` and the function would attempt to read `/etc/CLAUDE.md` and `/etc/.claude/CLAUDE.md`. While these specific filenames are unlikely to exist, the content of any file matching these names would be included in the restore response and injected into the conversation context.

  More importantly, `cwd` is used to construct `projectDbPath(cwd)` to read summaries and promoted entries, meaning a crafted `cwd` lets you query any project's database.
- **Proof:**
  ```typescript
  function readClaudeMdFiles(cwd: string): string {
    const paths = [
      { label: "~/.claude/CLAUDE.md", path: join(homedir(), ".claude", "CLAUDE.md") },
      { label: `${cwd}/CLAUDE.md`, path: join(cwd, "CLAUDE.md") },
      { label: `${cwd}/.claude/CLAUDE.md`, path: join(cwd, ".claude", "CLAUDE.md") },
    ];
    // ...
    const content = readFileSync(path, "utf8");
  ```
- **Recommendation:** Validate that `cwd` is an absolute path that exists and is a directory. This is partly addressed by the `cwd` canonicalization recommendation in SEC-NEW-4, which would naturally pair with a "must be a real existing directory" check.

---

## Low

### SEC-NEW-11 — PID file operations have TOCTOU race conditions

- **Severity:** Low
- **Subsystem:** Daemon lifecycle
- **Location:** `src/daemon/lifecycle.ts`
- **Description:** The `ensureDaemon()` function checks `existsSync(pidFilePath)` then reads it, with a gap between check and read. Similarly, `cleanStalePid()` checks then unlinks. On a system where multiple Claude sessions start simultaneously, two processes could both find no healthy daemon, both try to spawn one, and race on PID file creation. The health-check retry loop mitigates this in practice (second spawner will find the first's daemon healthy), but the PID file itself could be corrupted.
- **Proof:**
  ```typescript
  function cleanStalePid(pidFilePath: string): void {
    try {
      if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
    } catch { /* ignore */ }
  }
  ```
- **Recommendation:** Use atomic PID file creation with `O_EXCL` flag or an advisory lock (`flock`). This is low-severity because the retry loop provides adequate convergence in practice.

---

### SEC-NEW-12 — `deepMerge` in config allows prototype pollution

- **Severity:** Low
- **Subsystem:** Config loading
- **Location:** `src/daemon/config.ts` (deepMerge function)
- **Description:** The `deepMerge()` function iterates over `Object.keys(source)` and recursively merges. If a malicious `config.json` contains `"__proto__"` or `"constructor"` keys, the merge could pollute `Object.prototype`. In practice, `Object.keys()` does not return `__proto__` (it's not enumerable), and `JSON.parse` does not create prototype-polluted objects by default. However, the function has no explicit guard, and `"constructor"` IS enumerable and returned by `Object.keys()`.
- **Proof:**
  ```typescript
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      result[key] = (typeof source[key] === "object" && !Array.isArray(source[key]) && typeof target[key] === "object")
        ? deepMerge(target[key], source[key]) : source[key];
    }
  }
  ```
  A config with `{"constructor": {"prototype": {"polluted": true}}}` could theoretically pollute.
- **Recommendation:** Add a key denylist: `if (key === "__proto__" || key === "constructor" || key === "prototype") continue;`

---

### SEC-NEW-13 — API key logged in error message on provider misconfiguration

- **Severity:** Low
- **Subsystem:** Config loading
- **Location:** `src/daemon/config.ts:71`
- **Description:** After env-var substitution, the `apiKey` value is present in the merged config object. If config loading throws (e.g., due to invalid provider), the error message at line 78 includes the provider name but not the key. However, the resolved apiKey is in the config object, and if any downstream code includes the config in an error message or log, the key would leak. The `DIAGNOSTIC_SENSITIVE_KEY_PATTERN` in `summarize.ts` suggests awareness of this risk, but there's no systematic scrubbing of the config object after key resolution.
- **Recommendation:** After resolving the API key, mark it as sensitive or replace the in-memory value with a proxy that redacts on `.toString()`. At minimum, ensure error handlers never serialize the full config object.

---

## Info

### SEC-NEW-14 — `JSON.parse(body || "{}")` pattern has no error handling in some routes

- **Severity:** Info
- **Subsystem:** Multiple daemon routes
- **Location:** `session-complete.ts:10`, `store.ts:10`, `recent.ts:9`
- **Description:** Several routes call `JSON.parse(body || "{}")` outside a try/catch. If the body is malformed JSON (not empty, not valid), this throws and is caught by the server's top-level catch, which returns `err.message` — potentially including the malformed payload content in the error response. The routes that DO wrap this in try/catch (restore, compact) are fine; the ones that don't rely on the server-level handler.
- **Recommendation:** Wrap `JSON.parse` in a try/catch in each route, returning 400 with a generic "invalid JSON" message.

---

### SEC-NEW-15 — Unused `convStore` variable in `recent` route

- **Severity:** Info
- **Subsystem:** Recent route
- **Location:** `src/daemon/routes/recent.ts:29`
- **Description:** `const convStore = new ConversationStore(db)` is created but never used. This is a code quality issue, not a security vulnerability, but it indicates the route may be incomplete or was copy-pasted without cleanup.
- **Recommendation:** Remove unused variable.

---

## Summary

### Subsystems Audited — Clean

| Subsystem | Assessment |
|-----------|-----------|
| **SQLite layer** (conversation-store, summary-store) | All queries use parameterized `prepare().run()` / `prepare().get()` / `prepare().all()`. No string concatenation of user input into SQL. FTS5 queries go through `sanitizeFts5Query()`. LIKE queries use `escapeLike()` with proper `ESCAPE '\'` clause. **Clean.** |
| **CLI entry points** (lcm.ts, cli/*.ts) | Commander.js handles argument parsing. No `eval()` or shell injection vectors. Subcommands dispatch to typed handlers. **Clean.** |
| **Hooks dispatch** (hooks/dispatch.ts) | Hook command names are validated against a fixed allowlist (`HOOK_COMMANDS`). Session ID is sanitized before use in file paths (`replace(/[^a-zA-Z0-9_-]/g, "_")`). **Clean.** |
| **JSONL parsing** (transcript.ts, codex-transcript.ts) | Per-line `JSON.parse` in try/catch; malformed lines are silently skipped. No `eval()`. **Clean.** |
| **Scrub engine** (scrub.ts) | Pattern ordering is correct (built-in > global > project priority via index comparison). Range merging handles overlaps. Invalid patterns are caught and recorded. Token-splitting prevents cross-token greedy matching. **Clean.** |
| **FTS5 sanitization** (fts5-sanitize.ts) | Properly quotes each token in double-quotes, strips internal quotes, neutralizes boolean operators. Well-tested. **Clean.** |
| **LIKE search fallback** (full-text-fallback.ts) | `escapeLike()` properly escapes `\`, `%`, `_` and uses `ESCAPE '\'` in the SQL. **Clean.** |
| **Installer** (install.ts, uninstall.ts) | Uses `spawnSync` with array arguments (no shell injection). Binary resolution uses `command -v` via `spawnSync("sh", ["-c", ...])` — the command name is hardcoded ("lcm"), not user input. Config permissions issue is already covered in existing plan. **Clean.** |
| **Database migrations** (db/migration.ts) | All DDL uses string literals (no interpolation). `PRAGMA` statements are hardcoded. **Clean.** |
| **Signal handling** | Daemon uses standard Node.js server `.close()`. No custom signal handlers that could be abused. **Clean.** |
| **LLM process spawning** (claude-process.ts, codex-process.ts) | `spawn()` uses array arguments, not shell strings. codex-process creates temp files via `mkdtempSync` in OS tmpdir with cleanup in `finally`. claude-process pipes via stdin (no temp files). Timeouts prevent hung processes. **Clean.** |
| **Promoted store** (db/promoted.ts) | All SQL queries are parameterized. FTS5 search sanitizes by stripping non-word chars and quoting terms. **Clean.** |
| **Auto-heal** (hooks/auto-heal.ts) | Reads/writes settings.json with proper error handling. Operations are idempotent. Errors logged to file, never exposed to user. **Clean.** |

### Subsystems Not Fully Audited

| Subsystem | Reason |
|-----------|--------|
| **Expansion orchestrator** (`src/expansion.ts`) | Only examined the route handler and retrieval engine wrapper. The orchestrator itself was not fully read but uses typed inputs from the retrieval engine. Risk: low. |
| **Prompt templates** (`src/prompts/`) | Template loader was not examined. If templates use user content interpolation, there could be prompt injection vectors. The summarizer system prompt is loaded once at startup. Risk: low-medium. |

### Overall Security Posture

The codebase demonstrates good security awareness: parameterized SQL queries, FTS5 sanitization, session ID sanitization in file paths, and an existing security hardening plan. The main gaps are:

1. **Input validation at boundaries** — The daemon routes and MCP server trust their callers too much. The `cwd` parameter is the most pervasive unvalidated input.
2. **Resource limits** — No body size limit on the HTTP server is the most exploitable DoS vector.
3. **Defense in depth** — Error messages leak internals; config-sourced patterns aren't validated for safety.

With the 7 fixes from the existing plan AND the 13 new findings here, the tool would have a strong security posture for a localhost-only developer tool.
