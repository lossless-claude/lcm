# lcm Dogfooding Findings — 2026-03-22

## Bugs Found

### Bug 1: prompt-search only queries promoted store (CRITICAL)
**File:** `src/daemon/routes/prompt-search.ts:40`
**Symptom:** UserPromptSubmit hook always returns empty hints
**Root cause:** `store.search(query, maxResults)` only queries `PromotedStore` (4 entries). It never searches summaries (78) or messages (26K). The `/search` endpoint (used by MCP `lcm_search`) searches both episodic+semantic layers, but `/prompt-search` (used by the hook) only hits promoted.
**Fix:** Add summary FTS search to prompt-search. Either reuse the `/search` route's episodic layer, or create a `SummaryStore.search()` and merge results with promoted hits. Keep the recency/affinity scoring.

### Bug 2: `env: node: No such file or directory` in daemon.log
**File:** daemon spawn path (likely `src/daemon/lifecycle.ts`)
**Symptom:** Repeated `env: node: No such file or directory` in daemon.log. Hooks that shell out to `node` fail intermittently.
**Root cause:** When Claude Code spawns the daemon via `lcm daemon start --detach`, the child process inherits a minimal PATH that doesn't include the node binary location (`/opt/homebrew/Cellar/node/...`). The shebang `#!/usr/bin/env node` fails.
**Fix:** Either resolve node's absolute path at install time and write it into the daemon start script, or ensure the daemon spawn explicitly passes `PATH` from the parent environment.

### Bug 3: No request logging in daemon
**File:** `src/daemon/server.ts`
**Symptom:** Zero visibility into what the daemon processes at runtime. No way to debug prompt-search, hook calls, or MCP tool invocations.
**Root cause:** The HTTP server has no request logging middleware. Only startup messages go to daemon.log.
**Fix:** Add a simple request logger: timestamp, method, path, status code, duration. Respect `config.daemon.logLevel` (info: log all, warn: log errors only). Write to `~/.lossless-claude/daemon.log`.

### Bug 4: Config file has stale fields
**File:** `~/.lossless-claude/config.json`
**Symptom:** Config has `semanticTopK` and `semanticThreshold` under `restoration`, but the code expects `promptSearchMinScore`, `promptSearchMaxResults`, etc. Deep merge fills defaults so it works, but the config file is misleading.
**Fix:** Either migrate the config on install, or document the canonical fields. Not critical since defaults are correct.

### Bug 5: Dogfood skill checked wrong location for hooks
**File:** `.claude/commands/lcm-dogfood.md` (Phase 7)
**Symptom:** Skill checks `~/.claude/settings.json` for hook wiring, but lcm hooks are registered in `.claude-plugin/plugin.json`.
**Fix:** Update skill to check plugin.json instead. Settings.json only has third-party hooks (context-mode).

---

## Observations

- **Import:** Works well. 661 sessions, 32K messages. Idempotency correct (re-import only picks up new messages from current session).
- **Compact:** Running (slow due to summarizer calls). Needs timeout handling in the skill.
- **Sensitive patterns:** All 5 checks passed (list, test, add, test custom, remove).
- **Doctor:** 8/8 passed. Correctly validates hooks from plugin.json.
- **SessionStart hook:** Returns orientation context correctly.
- **MCP tools:** `/search` endpoint works (returns 5 episodic results), but `/prompt-search` is broken (Bug 1).
- **Daemon logging:** Only stderr warnings (SQLite experimental, punycode deprecated). No request logs (Bug 3).

---

## Suggested Fix Priority

1. **Bug 1** — prompt-search scope (critical: this is the core UX failure)
2. **Bug 3** — request logging (needed to debug everything else)
3. **Bug 2** — node PATH resolution (affects reliability)
4. **Bug 5** — skill fix (cosmetic but affects future dogfooding)
5. **Bug 4** — config migration (low priority)
