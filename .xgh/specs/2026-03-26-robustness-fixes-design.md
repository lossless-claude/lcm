# lcm Robustness Fixes — Design

**Date:** 2026-03-26
**Branch target:** develop
**Scope:** 3 bug fixes + 1 already-resolved item
**Review:** FOR/AGAINST by Sonnet 4.6, final synthesis by Opus 4.6

---

## 1. `lcm status` auth fix

### Problem
The `status` command in `bin/lcm.ts` fetches `/status` without an `Authorization` header. All daemon routes except `GET /health` require `Bearer <token>`. The request returns 401, `statusData` stays `null`:
- Non-JSON output falls back to terse `"daemon: up · provider: ..."` (no project stats)
- `--json` produces `{}` because `statusData?.daemon` and `statusData?.project` are both `undefined`

### Fix
In `bin/lcm.ts` `status` command action:
1. Try to read `~/.lossless-claude/daemon.token` with `readFileSync`. Wrap in try/catch:
   - `ENOENT` → proceed without auth, surface `"daemon: not initialized"` if status call fails
   - Any other error → proceed without auth
2. If token read succeeds, add `Authorization: Bearer <token>` to the `/status` POST fetch call.
3. On 401 response: surface `"daemon: token stale — restart daemon"` rather than silent fallback.

**Non-obvious upside (FOR):** `lcm status` becomes a 3-way health signal: daemon up + reachable + token valid. Reliable in CI scripts.

**Files changed:** `bin/lcm.ts`

### Test coverage
- Token present: assert `Authorization` header is sent, `statusData` is populated
- Token missing (ENOENT): assert graceful "not initialized" message, no crash
- 401 response: assert structured "token stale" message

---

## 2. `lcm daemon stop`

### Problem
`lcm daemon stop` errors with "too many arguments". Stopping requires manual `kill $(cat ~/.lossless-claude/daemon.pid)`, which skips graceful shutdown and may leave open SQLite write transactions.

### Fix
Add `daemonCmd.command("stop")` in `bin/lcm.ts`:

1. Read `~/.lossless-claude/daemon.pid`. If absent → print `"lcm daemon is not running"`, exit 0.
2. Parse PID. **Validate the process is actually an lcm process** before signaling: check `ps -p <pid> -o command=` contains `lcm` or `node`. If not → stale PID from OS reuse, remove file, exit 0.
3. If process is dead (`ESRCH`) → print `"lcm daemon is not running (stale pid file)"`, remove PID file, exit 0.
4. Send `SIGTERM`. Poll `kill -0 <pid>` every 200ms for up to 5s (not HTTP `/health` — process death is the real signal).
5. If process exits within 5s → print `"lcm daemon stopped"`, **then** remove PID file, exit 0.
6. If still alive after 5s → escalate to `SIGKILL`, wait 500ms, remove PID file, exit 0 with warning.

**Critical:** PID file removal must be the **last** step — removing it before process death allows a concurrent `daemon start` to spawn a second instance competing for the same port and SQLite DB.

**Files changed:** `bin/lcm.ts`

### Test coverage
- Normal stop: SIGTERM → process dies → PID file removed
- Stale PID (dead process): clean exit, file removed
- PID recycling: non-lcm process at PID → no SIGTERM sent
- SIGKILL escalation path: process ignores SIGTERM

---

## 3. Plugin cache version-stamp (replaces PATH-first approach)

### Problem
`plugin.json` hooks invoke `node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs"`, which delegates to `${CLAUDE_PLUGIN_ROOT}/dist/bin/lcm.js`. During development, the running daemon may be from a newer build, causing version skew between hook logic and daemon behavior. (Root cause of the PR #138 incident.)

### Why PATH-first was rejected
`execSync("which lcm")` on every hook invocation:
- **Hangs** in Docker/CI with restricted PATH or no `which` binary
- **Infinite recursion** if PATH `lcm` wraps `lcm.mjs` (no cycle guard)
- **Fragile comparison** under macOS HFS+ (case-insensitive) and symlink farms

### Fix (version-stamp approach)
In `lcm.mjs`, after auto-bootstrap and before delegation:

1. Read `CLAUDE_PLUGIN_ROOT`'s version from `package.json` (`__dirname + "/package.json"`).
2. Fetch `http://127.0.0.1:<port>/health` (non-blocking, 500ms timeout). Parse `version` field.
3. If health fetch succeeds and `health.version !== pluginVersion` → write a one-line warning to stderr:
   ```
   [lcm] version mismatch: plugin=0.7.0 daemon=0.8.0 — run `lcm install` to update
   ```
4. Continue with normal delegation regardless (warning only, never blocking).

This is **zero-fork, no PATH assumptions, no recursion risk**. The warning surfaces in Claude Code's hook output where developers will see it.

**Files changed:** `lcm.mjs`

### Test coverage
- Version match: no warning emitted
- Version mismatch: warning written to stderr, delegation continues
- Health fetch fails (daemon down): no warning, no crash, delegation continues

---

## 4. `safe-regex` missing from `node_modules` — RESOLVED

`safe-regex@^2.1.1` was already in `package.json` and `package-lock.json`. The missing entry was a stale local `node_modules` fixed by `npm install`. No code change required.

---

## Delivery

Three independent commits in one PR targeting `develop`:

| Commit | Change |
|--------|--------|
| `fix: add auth token to lcm status daemon request` | Fix #1 |
| `fix: add lcm daemon stop subcommand` | Fix #2 |
| `fix: warn on plugin/daemon version mismatch in lcm.mjs` | Fix #3 |

After merge → bump to v0.7.1 and publish.
