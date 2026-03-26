# lcm Robustness Fixes — Design

**Date:** 2026-03-26
**Branch target:** develop
**Scope:** 3 independent bug fixes + 1 already-resolved item

---

## 1. `lcm status` auth fix

### Problem
The `status` command in `bin/lcm.ts` fetches `/status` from the daemon without an `Authorization` header. All daemon routes except `GET /health` require `Bearer <token>`. The request returns 401, `statusData` stays `null`, and:
- Non-JSON output falls back to the terse `"daemon: up · provider: ..."` line (no project stats)
- `--json` output produces `{}` because `statusData?.daemon` and `statusData?.project` are both `undefined`

### Fix
In `bin/lcm.ts` `status` command action:
1. Read `~/.lossless-claude/daemon.token` using `readFileSync` (same pattern as `readAuthToken` in `src/daemon/auth.ts`). If the file is absent, proceed without auth (daemon may not require it in some configs).
2. Add `Authorization: Bearer <token>` to the `/status` POST fetch call.

**Files changed:** `bin/lcm.ts`

### Test coverage
- Unit test: mock the `/status` route handler and assert the Authorization header is present in the request
- Integration smoke: `lcm status` shows project stats after fix; `lcm status --json` returns a non-empty object with `daemon.version` and `project.messageCount`

---

## 2. `lcm daemon stop`

### Problem
`lcm daemon stop` errors with "too many arguments". Stopping the daemon requires manually reading the PID file and sending SIGTERM — there is no CLI command.

### Fix
Add `daemonCmd.command("stop")` in `bin/lcm.ts`:

1. Read `~/.lossless-claude/daemon.pid`. If absent, print `"lcm daemon is not running"` and exit 0.
2. Parse the PID. If the process is not alive (`process.kill(pid, 0)` throws ESRCH), print `"lcm daemon is not running (stale pid file)"`, remove PID file, exit 0.
3. Send `SIGTERM`. Poll `GET /health` for up to 2 s (5 × 400 ms). If health stops responding: print `"lcm daemon stopped"`, remove PID file, exit 0.
4. If still alive after 2 s: print `"lcm daemon did not stop in time — PID <n> still alive"`, exit 1.

**Files changed:** `bin/lcm.ts`

### Test coverage
- Unit test with `_spawnOverride`-style mock: assert SIGTERM is sent to the correct PID
- Test stale-PID path: PID file exists, process is dead → clean exit 0 + PID file removed

---

## 3. `lcm.mjs` PATH-first delegation

### Problem
`plugin.json` hooks invoke `node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs"`. `lcm.mjs` always delegates to `${CLAUDE_PLUGIN_ROOT}/dist/bin/lcm.js` — the plugin-cache binary. During development, the daemon may be running from a different (newer) build, causing version skew between hook logic and daemon behavior.

### Fix
In `lcm.mjs`, before the final `import(cliModule)` delegation:

1. Resolve `lcm` from PATH using a synchronous `execSync("which lcm 2>/dev/null")` (or iterate `process.env.PATH`). Wrap in try/catch — if it throws, PATH resolution failed.
2. If a PATH binary is found **and** its resolved path differs from `__dirname` (i.e., it is not the plugin cache itself):
   - `spawnSync(pathBinary, process.argv.slice(2), { stdio: "inherit" })` and `process.exit(result.status ?? 0)`.
3. Otherwise fall through to the existing plugin-cache delegation (`import(cliModule)`).

This means: dev builds and globally-installed `lcm` (e.g., via npm or Homebrew) take precedence. Plugin-only users (no PATH binary) are unaffected.

**Files changed:** `lcm.mjs`

### Test coverage
- Manual smoke: symlink a test binary to PATH, verify `lcm.mjs` delegates to it instead of plugin cache
- Unit: mock `execSync` to return a different path; assert `spawnSync` is called with that path

---

## 4. `safe-regex` missing from `node_modules` — RESOLVED

`safe-regex@^2.1.1` was already in `package.json` and `package-lock.json`. The missing `node_modules` entry was a stale local state fixed by `npm install`. No code change required.

---

## Delivery

All three fixes are independent and can land in a single PR targeting `develop`. Each fix has its own commit for clean bisect history:

| Commit | Change |
|--------|--------|
| `fix: add auth token to lcm status daemon request` | Fix #1 |
| `fix: add lcm daemon stop subcommand` | Fix #2 |
| `fix: prefer PATH lcm over plugin cache in lcm.mjs` | Fix #3 |

After merge, bump to v0.7.1 and publish.
