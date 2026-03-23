---
description: "This command runs a comprehensive lcm self-test covering all CLI commands, 4 hooks, 8 MCP tools, and resilience in a live session. Trigger when validating a new build, after refactors, or before releases. Dev-only (not shipped in npm)."
user_invocable: true
argument: "[phase]"
---

# /lcm-dogfood — Live Self-Test Suite

Run all lcm public surface in a live Claude Code session. Reports pass/fail per check with a final scorecard.

**Usage:** `/lcm-dogfood [phase]` where phase is: `all` (default), `health`, `import`, `compact`, `promote`, `sensitive`, `pipeline`, `hooks`, `mcp`, `resilience`, `debug`

---

## Instructions

Execute each check below **in order** (or just the requested phase). For each check:

1. Run the command or verify the condition
2. Record the result: ✅ PASS, ❌ FAIL, or ⚠️ SKIP (with reason)
3. On FAIL: capture the error, check daemon logs (`~/.lossless-claude/daemon.log`), and **continue** (do not stop)
4. At the end, produce the **Scorecard** table
5. Write failures + debug notes to `.xgh/reviews/dogfood-YYYY-MM-DD.md`

**Routing:** Use `ctx_execute` (context-mode sandbox) for commands producing large output. Use Bash only for short-output commands. Use MCP tools directly for Phase 8.

---

## Phase 1: Health (`health`) — 3 checks

### Check 1.1 — Daemon status
```bash
node dist/bin/lcm.js status
```
**Pass if:** daemon shows "up", project registered for current cwd, port 3737.

### Check 1.2 — Doctor
```bash
node dist/bin/lcm.js doctor
```
**Pass if:** all checks pass (8 passed, 0 failed). Record any warnings.

### Check 1.3 — Version
```bash
node dist/bin/lcm.js --version
```
**Pass if:** prints version string matching package.json.

---

## Phase 2: Import (`import`) — 3 checks

### Check 2.1 — Import session transcripts
```bash
node dist/bin/lcm.js import --all --verbose
```
**Pass if:** message count > 0, no errors. Use `ctx_execute` — output can be large.

### Check 2.2 — Status after import
```bash
node dist/bin/lcm.js status
```
**Pass if:** messages > 0, last ingest timestamp updated.

### Check 2.3 — Idempotent re-import
Run import again immediately.
**Pass if:** message count unchanged or only current-session messages added (small delta). No duplicates.

---

## Phase 3: Compact (`compact`) — 3 checks

### Check 3.1 — Compact messages
```bash
node dist/bin/lcm.js compact --all --verbose
```
**Pass if:** summaries created, compression ratio reported. **Note:** This calls the summarizer (LLM) and may take minutes. Use a 5-minute timeout.

### Check 3.2 — Status after compact
```bash
node dist/bin/lcm.js status
```
**Pass if:** summaries > 0.

### Check 3.3 — Idempotent re-compact
Run compact again immediately.
**Pass if:** no new summaries created ("nothing to compact" or 0 new).

---

## Phase 4: Promote (`promote`) — 2 checks

### Check 4.1 — Promote insights
```bash
node dist/bin/lcm.js promote --all --verbose
```
**Pass if:** promoted count increments OR "no promotable content" (valid if summaries too short).

### Check 4.2 — Stats
```bash
node dist/bin/lcm.js stats --verbose
```
**Pass if:** shows messages, summaries, promoted counts, compression ratios. Numbers consistent with previous checks.

---

## Phase 5: Sensitive Patterns (`sensitive`) — 5 checks

### Check 5.1 — List patterns
```bash
node dist/bin/lcm.js sensitive list
```
**Pass if:** shows 7 built-in patterns.

### Check 5.2 — Test scrubbing
```bash
node dist/bin/lcm.js sensitive test "my api key is sk-1234567890abcdefghij and password=hunter2"
```
**Pass if:** both API key and password are `[REDACTED]`.

### Check 5.3 — Add custom pattern
```bash
node dist/bin/lcm.js sensitive add "DOGFOOD_SECRET_\w+"
```
**Pass if:** pattern added.

### Check 5.4 — Test custom pattern
```bash
node dist/bin/lcm.js sensitive test "the value is DOGFOOD_SECRET_abc123"
```
**Pass if:** `DOGFOOD_SECRET_abc123` is `[REDACTED]`.

### Check 5.5 — Remove custom pattern
```bash
node dist/bin/lcm.js sensitive remove "DOGFOOD_SECRET_\w+"
```
**Pass if:** pattern removed. Run `sensitive list` to confirm it's gone.

---

## Phase 6: Full Pipeline (`pipeline`) — 2 checks

### Check 6.1 — Curate (import + compact + promote)
```bash
node dist/bin/lcm.js import --all && node dist/bin/lcm.js compact --all && node dist/bin/lcm.js promote --all
```
**Pass if:** all three stages complete without error. Use 5-minute timeout for compact.

### Check 6.2 — Diagnose
```bash
node dist/bin/lcm.js diagnose --verbose
```
**Pass if:** no hook failures or ingestion gaps detected.

---

## Phase 7: Hook Verification (`hooks`) — 6 checks

**IMPORTANT:** lcm hooks are registered in `.claude-plugin/plugin.json`, NOT `~/.claude/settings.json`. Settings.json only has third-party hooks (context-mode etc.).

### Check 7.1 — Hook wiring in plugin.json
Read `.claude-plugin/plugin.json` and verify all 4 hooks exist:
- `SessionStart` → `lcm restore`
- `UserPromptSubmit` → `lcm user-prompt`
- `PreCompact` → `lcm compact`
- `SessionEnd` → `lcm session-end`

**Pass if:** all 4 present with correct commands.

### Check 7.2 — SessionStart live test
```bash
echo '{}' | node dist/bin/lcm.js restore
```
**Pass if:** returns `<memory-orientation>` block with guidelines.

### Check 7.3 — UserPromptSubmit live test
```bash
node -e 'console.log(JSON.stringify({ prompt: "what changes were made to the summarizer", cwd: process.cwd() }))' | node dist/bin/lcm.js user-prompt
```
**Pass if:** returns `<memory-context>` block with hints.
**Known issue (Bug 1):** Currently only searches promoted store (few entries). If empty, this is expected until Bug 1 is fixed. Record as ⚠️ KNOWN.

### Check 7.4 — UserPromptSubmit daemon endpoint
Test the daemon directly to separate hook logic from daemon logic:
```bash
node .claude/commands/lcm-dogfood-scripts/prompt-search-test.js "summarizer"
```
**Pass if:** returns `{"hints":[...]}` (may be empty — see Bug 1).

### Check 7.5 — Hook timeout
```bash
time node -e 'console.log(JSON.stringify({ prompt: "test", cwd: process.cwd() }))' | node dist/bin/lcm.js user-prompt
```
**Pass if:** completes in < 5 seconds.

### Check 7.6 — SessionEnd wiring (read-only)
Cannot trigger without ending session. Verify wiring exists in plugin.json (covered by 7.1).
**Pass if:** wiring confirmed in 7.1.

---

## Phase 8: MCP Tools (`mcp`) — 8 checks

Use the lcm MCP tools directly. If MCP server is not connected, try via daemon HTTP API as fallback.

### Check 8.1 — lcm_doctor via MCP
Call `lcm_doctor` MCP tool.
**Pass if:** returns diagnostic results with pass/fail counts.

### Check 8.2 — lcm_stats via MCP
Call `lcm_stats` MCP tool with `verbose: true`.
**Pass if:** returns stats with message/summary/promoted counts.

### Check 8.3 — lcm_search via MCP
Call `lcm_search` with `query: "summarizer"`.
**Pass if:** `episodic` results array has > 0 entries.

### Check 8.4 — lcm_grep via MCP
Call `lcm_grep` with `query: "compact", scope: "all"`.
**Pass if:** returns matching entries.

### Check 8.5 — lcm_store via MCP
Call `lcm_store` with `text: "dogfood test memory — <today's date>", tags: ["dogfood", "test"]`.
**Pass if:** returns stored ID (UUID).

### Check 8.6 — lcm_search retrieval verification
Call `lcm_search` with `query: "dogfood test memory"`.
**Pass if:** the memory stored in 8.5 appears in results.

### Check 8.7 — lcm_expand via MCP
Take any summary node ID from previous search results and call `lcm_expand` with `nodeId: "<id>"`.
**Pass if:** returns expanded content with DAG traversal. ⚠️ SKIP if no summary IDs available.

### Check 8.8 — lcm_describe via MCP
Call `lcm_describe` with the same node ID.
**Pass if:** returns metadata (depth, tokens, parent/child links). ⚠️ SKIP if no node ID.

---

## Phase 9: Resilience (`resilience`) — 3 checks

### Check 9.1 — Kill daemon
```bash
pkill -f "lcm.*daemon" || true
sleep 1
node dist/bin/lcm.js status
```
**Pass if:** reports daemon is down clearly (no crash, no hang).

### Check 9.2 — Auto-recovery
```bash
node dist/bin/lcm.js daemon start --detach
sleep 2
node dist/bin/lcm.js status
```
**Pass if:** daemon comes back up, status shows "up".

### Check 9.3 — Graceful degradation while daemon-down
Kill daemon, then test hook:
```bash
pkill -f "lcm.*daemon" || true
sleep 1
timeout 10 sh -c 'echo "{\"prompt\":\"test\",\"cwd\":\"$(pwd)\"}" | node dist/bin/lcm.js user-prompt'
echo "exit: $?"
```
**Pass if:** returns within 10s, no crash. Empty output is acceptable. Then restart daemon for remaining checks.

---

## Phase 10: Debug Diagnostics (`debug`) — 4 checks

### Check 10.1 — Daemon logs
```bash
tail -50 ~/.lossless-claude/daemon.log
```
**Pass if:** no ERROR entries. Note `env: node: No such file or directory` (Bug 2) and SQLite experimental warnings.

### Check 10.2 — PWD matches cwd
```bash
echo "PWD=$PWD" && echo "cwd=$(pwd)"
```
**Pass if:** identical. Mismatch indicates MCP tool routing issues.

### Check 10.3 — Project DB exists
```bash
ls -la ~/.lossless-claude/projects/*/lcm.db 2>/dev/null
```
**Pass if:** at least one .db file exists for current project.

### Check 10.4 — DB integrity
```bash
node .claude/commands/lcm-dogfood-scripts/db-integrity.js
```
**Pass if:** all DBs report "ok".

---

## Scorecard

After all checks, produce this table:

```
| Phase       | Checks | ✅ Pass | ❌ Fail | ⚠️ Skip/Known |
|-------------|--------|---------|---------|---------------|
| Health      | 3      |         |         |               |
| Import      | 3      |         |         |               |
| Compact     | 3      |         |         |               |
| Promote     | 2      |         |         |               |
| Sensitive   | 5      |         |         |               |
| Pipeline    | 2      |         |         |               |
| Hooks       | 6      |         |         |               |
| MCP         | 8      |         |         |               |
| Resilience  | 3      |         |         |               |
| Debug       | 4      |         |         |               |
| **TOTAL**   | **39** |         |         |               |
```

For ❌ FAIL items, include: error message, daemon log excerpt, suggested fix.
For ⚠️ KNOWN items, reference the bug number from `.xgh/plans/2026-03-22-dogfood-findings.md`.

---

## Known Issues (reference)

Track bugs at: `.xgh/plans/2026-03-22-dogfood-findings.md`

| Bug | Summary | Affects |
|-----|---------|---------|
| 1 | prompt-search only queries promoted store, not summaries | Check 7.3, 7.4 |
| 2 | `env: node: No such file or directory` in daemon.log | Check 10.1 |
| 3 | No request logging in daemon | Check 10.1 |
| 4 | Config file has stale restoration fields | N/A (defaults work) |
| 5 | _(fixed)_ Skill checked settings.json instead of plugin.json | Check 7.1 |
