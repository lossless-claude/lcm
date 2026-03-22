---
name: lcm-dogfood
description: "This skill should be used when the user asks to \"run lcm dogfood\", \"self-test lcm\", \"validate lcm build\", \"test lcm hooks\", \"check lcm mcp tools\", or mentions lcm QA, regression testing, or pre-release validation. Runs a comprehensive 39-check self-test across all CLI commands, hooks, MCP tools, and resilience."
user_invocable: true
argument: "[phase]"
---

# lcm Dogfood — Live Self-Test Suite

Comprehensive self-test for the lcm system in a live Claude Code session. Covers all 9 CLI commands, 4 hooks, 8 MCP tools, and resilience scenarios across 39 checks in 10 phases.

**Arguments:** `all` (default), `health`, `import`, `compact`, `promote`, `sensitive`, `pipeline`, `hooks`, `mcp`, `resilience`, `debug`

## Procedure

Execute each phase in order (or just the requested phase). For each check:

1. Run the command or verify the condition
2. Record: ✅ PASS, ❌ FAIL, or ⚠️ SKIP (with reason)
3. On FAIL: capture error, check daemon logs (`~/.lossless-claude/daemon.log`), continue
4. Produce the **Scorecard** at the end
5. Write failures to `.xgh/reviews/dogfood-YYYY-MM-DD.md`

**Routing:** Use `ctx_execute` (context-mode sandbox) for commands producing large output. Use Bash for short-output commands. Use MCP tools directly for Phase 8.

Consult `references/checks.md` for detailed pass/fail criteria for each check.

## Phase Overview

| # | Phase | Checks | What it tests |
|---|-------|--------|---------------|
| 1 | Health | 3 | Daemon status, doctor, version |
| 2 | Import | 3 | Transcript ingestion + idempotency |
| 3 | Compact | 3 | Summarization + idempotency |
| 4 | Promote | 2 | Insight extraction + stats consistency |
| 5 | Sensitive | 5 | Pattern list/test/add/remove cycle |
| 6 | Pipeline | 2 | Full curate + diagnose |
| 7 | Hooks | 6 | Wiring verification + live tests |
| 8 | MCP | 8 | All 7 MCP tools + store-retrieve roundtrip |
| 9 | Resilience | 3 | Kill/restart/graceful degradation |
| 10 | Debug | 4 | Logs, PWD, DB existence, integrity |

## Key Commands

All CLI checks use `node dist/bin/lcm.js <subcommand>`. If `lcm` is on PATH, use that instead.

### Hook Verification

Hooks are registered in `.claude-plugin/plugin.json`, NOT `~/.claude/settings.json`. Verify all 4:
- `SessionStart` → `lcm restore`
- `UserPromptSubmit` → `lcm user-prompt`
- `PreCompact` → `lcm compact`
- `SessionEnd` → `lcm session-end`

For live hook testing, pipe JSON to stdin:
```bash
echo '{}' | node dist/bin/lcm.js restore
```

The UserPromptSubmit hook requires `prompt` and `cwd` fields:
```bash
node -e 'console.log(JSON.stringify({prompt:"test query",cwd:process.cwd()}))' | node dist/bin/lcm.js user-prompt
```

### MCP Tool Testing

Call lcm MCP tools directly from the session. All 8 tools to test:
`lcm_doctor`, `lcm_stats`, `lcm_search`, `lcm_grep`, `lcm_store`, `lcm_expand`, `lcm_describe` + store-retrieve roundtrip.

## Scorecard Template

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
For ⚠️ KNOWN items, reference the bug number from `references/known-issues.md`.

## Bundled Resources

### Scripts

Utility scripts for checks that require custom logic:
- **`scripts/prompt-search-test.js`** — Test the daemon `/prompt-search` endpoint directly. Usage: `node scripts/prompt-search-test.js "query" [cwd]`
- **`scripts/db-integrity.js`** — Check PRAGMA integrity_check on all project databases. Usage: `node scripts/db-integrity.js`

### Reference Files

- **`references/checks.md`** — All 39 checks with detailed pass/fail criteria, organized by phase
- **`references/known-issues.md`** — Known bugs with root causes, affected checks, and fix status
