# lcm Robustness Gaps — 2026-03-26

Gaps identified during dogfooding after PR #138 merge.

---

## 1. `lcm status --json` returns `{}`  ★ BUG

```
node dist/bin/lcm.js status --json  →  {}
```

The JSON output is empty. The non-JSON path renders "daemon: up · provider: claude-process" but omits project stats too. Status used to show messages/summaries/promoted counts — that detail is now missing or only appears in specific conditions.

**Fix needed:** audit `status` command JSON serialization and project-context resolution.

---

## 2. `lcm status` omits project stats  ★ REGRESSION

Non-JSON output: `daemon: up · provider: claude-process` — no message count, last ingest, last promote, etc.

Previously the status command showed:
```
  Messages: 43368
  Summaries: 793
  Promoted: 2130
  Last Ingest: ...
```

Likely regressed when status was refactored. The project context may not be resolved when invoking from a directory that isn't the configured project root.

---

## 3. No `lcm daemon stop` command  ★ MISSING

`lcm daemon stop` errors: "too many arguments". Stopping the daemon requires:
```bash
kill $(cat ~/.lossless-claude/daemon.pid)
# or
lsof -i :3737 -P -n | awk 'NR>1{print $2}' | xargs kill
```

**Fix needed:** add `lcm daemon stop` subcommand (reads pid file, sends SIGTERM).

---

## 4. Plugin cache version drift (root cause, partially mitigated)  ★ SYSTEMIC

The hook scripts installed by `lcm install` reference the plugin-cached binary path (e.g., `~/.claude/plugins/cache/*/lossless-claude/*/lcm.mjs`). When lcm is updated from the dev repo, the cached binary stays at the old version. The cached binary's `SessionStart` hook spawns an old daemon on port 3737.

**What PR #138 fixed:** `ensureDaemon` now rejects a mismatched-version daemon from the health wait, so `connected: false` is returned instead of silently connecting to the wrong version.

**What's still needed:**
- `lcm install` should update the plugin cache entry to point to the system binary, OR
- The hook script should resolve `lcm` from PATH (not plugin cache), OR
- A startup check should detect version drift early and print a clear warning + instructions.

---

## 5. `safe-regex` not installed locally  ✅ RESOLVED

`safe-regex@^2.1.1` was in `package.json` + `package-lock.json` but not in `node_modules`. Fixed by running `npm install`. Cause: stale local node_modules after pulling. Not systemic for fresh installs.

---

## 6. `events-staleness` warning: last capture 1h ago

`doctor` shows `⚠️ project-patterns — none configured`. Separate from staleness — the events capture is working (0 errors), just no project patterns set. Low priority.

---

## Priority

| # | Issue | Severity |
|---|-------|----------|
| 1 | `status --json` broken | medium |
| 2 | `status` missing project stats | medium |
| 3 | `daemon stop` missing | low |
| 4 | Plugin cache drift (partial fix) | high — next PR target |
