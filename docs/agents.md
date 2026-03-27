# Skills

lossless-claude includes 4 skills that Claude can invoke during a session. Skills are agent-facing — they guide Claude's behavior for specific tasks.

## Skill overview

| Skill | Trigger | What it does |
|-------|---------|-------------|
| [lcm-context](#lcm-context) | Deciding which MCP tool to call | Decision tree for picking the right memory tool |
| [lcm-dogfood](#lcm-dogfood) | `/lcm-dogfood` or "run lcm self-test" | 39-check self-test across CLI, hooks, MCP, resilience |
| [lcm-e2e](#lcm-e2e) | End-to-end validation request | Full E2E checklist against a live installation |
| [lossless-claude-upgrade](#lossless-claude-upgrade) | Upgrade request | Rebuild from source, restart daemon, verify |

---

## lcm-context

Guides Claude in selecting the right lcm MCP tool for a given task. Provides a decision tree, usage guidelines, and error self-healing patterns.

**Retrieval chain:**
```
lcm_search (broad concept recall)
    ↓
lcm_grep (exact keyword match)
    ↓
lcm_expand (decompress summary node)
```

Use `lcm_describe` before expanding to check whether a node is worth the token cost.

**Error self-healing:**

| Error | Recovery |
|-------|----------|
| Daemon not running | Run `lcm start`, retry |
| No results | Try `lcm_grep` with different keywords |
| Node not found | Use `lcm_search` to find correct nodeId |

---

## lcm-dogfood

Comprehensive self-test suite for validating the entire lcm system in a live Claude Code session. Covers 39 checks across 10 phases.

**Phases:**

| Phase | Checks | Tests |
|-------|--------|-------|
| Health | 3 | Daemon status, doctor, version |
| Import | 3 | Transcript ingestion + idempotency |
| Compact | 3 | Summarization + idempotency |
| Promote | 2 | Insight extraction + stats consistency |
| Sensitive | 5 | Pattern list/test/add/remove cycle |
| Pipeline | 2 | Full curate + diagnose |
| Hooks | 6 | Wiring verification + live tests |
| MCP | 8 | All 7 MCP tools + store-retrieve roundtrip |
| Resilience | 3 | Kill/restart/graceful degradation |
| Debug | 4 | Logs, PWD, DB existence, integrity |

Produces a scorecard and writes failures to a review file.

**Bundled resources:**
- `scripts/prompt-search-test.js` — Tests the daemon `/prompt-search` endpoint
- `scripts/db-integrity.js` — Runs PRAGMA integrity_check on all project databases
- `references/checks.md` — Detailed pass/fail criteria for all 39 checks
- `references/known-issues.md` — Known bugs with fix status

---

## lcm-e2e

End-to-end validation checklist against a real lcm installation. Tests daemon, hooks, import, compact, promote, retrieval, and resilience.

**Data isolation:** All operations use an isolated temp directory — never touches user data. The temp cwd creates a separate project database that is cleaned up after the test.

**Flow subsets:** `import`, `compact`, `promote`, `curate`, `retrieval`, `hooks`, `doctor`, `cleanup`

---

## lossless-claude-upgrade

Rebuilds lossless-claude from source, restarts the daemon, and verifies the installation.

**Steps:**
1. Build from source (`npm run build && npm link`)
2. Kill and restart daemon
3. Run `lcm doctor` to verify
4. Report results as a checklist

After upgrade, the user should restart their Claude Code session to pick up the new version.
