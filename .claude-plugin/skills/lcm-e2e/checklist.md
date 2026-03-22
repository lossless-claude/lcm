# lcm E2E Validation Checklist

> **Note:** Some flows reference planned CLI flags (e.g., `--cwd`, `hook` subcommand) and MCP tools not yet implemented. These serve as a roadmap for future coverage.

All flows run against an isolated temp directory. No user project data is touched.

---

## Setup

Before any flow, create the temp working directory:

```bash
LCME2E_DIR=$(mktemp -d /tmp/lcm-e2e-test-XXXXXX)
echo "Test dir: $LCME2E_DIR"
```

All subsequent commands are run with `--cwd $LCME2E_DIR` or `cd $LCME2E_DIR &&` as appropriate.

---

## Flow 1 — Environment

**Goal:** Verify lcm binary is installed and daemon is reachable.

| Step | Command | Expected |
|------|---------|----------|
| 1.1 | `lcm --version` | Prints version string (e.g. `lcm 0.x.y`) |
| 1.2 | `lcm status --json` | JSON with `daemon: "running"` or attempt start |
| 1.3 | `lcm daemon start --detach` (if 1.2 failed) | Daemon starts, PID file created |
| 1.4 | `lcm status --json` | JSON with `daemon: "running"` |

**Pass criteria:** lcm binary found, daemon running after step 1.4.

---

## Flow 2 — Import

**Goal:** Ingest a synthetic transcript into the isolated project.

```bash
cat > $LCME2E_DIR/e2e-session.jsonl << 'FIXTURE'
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"What database should we use for the project?"}]},"timestamp":"2024-01-01T00:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We decided to use SQLite instead of PostgreSQL because it requires zero infrastructure. The ConversationStore class in src/store/conversation-store.ts handles all CRUD operations."}]},"timestamp":"2024-01-01T00:01:00Z"}
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"What should the API authentication strategy be?"}]},"timestamp":"2024-01-01T00:02:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We agreed on JWT tokens with 24-hour expiry. The AuthMiddleware in src/middleware/auth.ts validates every request. API keys are stored hashed with bcrypt, never in plaintext."}]},"timestamp":"2024-01-01T00:03:00Z"}
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"How should we handle errors globally?"}]},"timestamp":"2024-01-01T00:04:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"All unhandled errors go through the ErrorHandler class in src/middleware/error-handler.ts. It logs to stderr and returns a structured JSON response with code, message, and request ID."}]},"timestamp":"2024-01-01T00:05:00Z"}
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"What test framework are we using?"}]},"timestamp":"2024-01-01T00:06:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We chose Vitest over Jest because it's faster with native ESM support. Test files live in src/__tests__/ with .test.ts suffix. Coverage threshold is 80%."}]},"timestamp":"2024-01-01T00:07:00Z"}
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"How do we deploy?"}]},"timestamp":"2024-01-01T00:08:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Docker containers pushed to ECR, deployed via ECS Fargate. The Dockerfile uses multi-stage builds: builder stage compiles TypeScript, runtime stage copies dist/ only. No Node dev dependencies in production image."}]},"timestamp":"2024-01-01T00:09:00Z"}
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"What's the branching strategy?"}]},"timestamp":"2024-01-01T00:10:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Trunk-based development: main is always deployable. Feature branches merge via PR. We use conventional commits (feat:, fix:, chore:) enforced by commitlint. Semantic-release handles versioning automatically."}]},"timestamp":"2024-01-01T00:11:00Z"}
FIXTURE
```

| Step | Command | Expected |
|------|---------|----------|
| 2.1 | Create fixture file (above) | File `$LCME2E_DIR/e2e-session.jsonl` exists |
| 2.2 | `lcm import $LCME2E_DIR/e2e-session.jsonl --cwd $LCME2E_DIR` | Exit 0, prints imported message count |
| 2.3 | `lcm status --json --cwd $LCME2E_DIR` | JSON contains `conversations` count ≥ 1 |

**Pass criteria:** Import exits 0, at least 1 conversation recorded.

---

## Flow 3 — Idempotent Re-import

**Goal:** Re-running import on the same file produces no duplicate records.

| Step | Command | Expected |
|------|---------|----------|
| 3.1 | `lcm status --json --cwd $LCME2E_DIR` (capture baseline count) | Record baseline `conversations` value |
| 3.2 | `lcm import $LCME2E_DIR/e2e-session.jsonl --cwd $LCME2E_DIR` | Exit 0, prints "0 new" or "already imported" |
| 3.3 | `lcm status --json --cwd $LCME2E_DIR` | `conversations` count unchanged from 3.1 |

**Pass criteria:** Count after re-import equals count before re-import.

---

## Flow 4 — Subagent Import

**Goal:** Ingest a subagent transcript and verify it is stored separately.

```bash
cat > $LCME2E_DIR/e2e-subagent.jsonl << 'FIXTURE'
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"Subagent task: analyze the database schema"}]},"timestamp":"2024-01-02T00:00:00Z","subagent":true}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Schema analysis complete. Found 3 tables: users, sessions, memories. The memories table has a full-text search index on the content column. Foreign key from sessions to users is indexed."}]},"timestamp":"2024-01-02T00:01:00Z","subagent":true}
FIXTURE
```

| Step | Command | Expected |
|------|---------|----------|
| 4.1 | Create subagent fixture (above) | File exists |
| 4.2 | `lcm import $LCME2E_DIR/e2e-subagent.jsonl --cwd $LCME2E_DIR` | Exit 0 |
| 4.3 | `lcm status --json --cwd $LCME2E_DIR` | `conversations` count increased by 1 |

**Pass criteria:** Subagent data ingested, total count incremented.

---

## Flow 5 — Compact

**Goal:** Run compaction and verify DAG memory nodes are created.

| Step | Command | Expected |
|------|---------|----------|
| 5.1 | `lcm compact --all --cwd $LCME2E_DIR` | Exit 0, prints nodes created count |
| 5.2 | `lcm status --json --cwd $LCME2E_DIR` | JSON contains `memories` or `nodes` count ≥ 1 |

**Pass criteria:** Compact exits 0, at least 1 memory node exists.

---

## Flow 6 — Promote

**Goal:** Run promotion and verify promoted memories exist.

| Step | Command | Expected |
|------|---------|----------|
| 6.1 | `lcm promote --cwd $LCME2E_DIR` | Exit 0, prints promoted count |
| 6.2 | `lcm status --json --cwd $LCME2E_DIR` | JSON contains `promoted` count ≥ 1 |

**Pass criteria:** Promote exits 0, at least 1 promoted memory.

---

## Flow 7 — Curate (Full Pipeline)

**Goal:** Verify the full import → compact → promote pipeline works end-to-end.

```bash
cat > $LCME2E_DIR/e2e-curate.jsonl << 'FIXTURE'
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"What logging library should we use?"}]},"timestamp":"2024-01-03T00:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"We chose pino over winston for structured logging. It outputs JSON by default and is 5x faster. The LoggerService in src/services/logger.ts wraps pino and adds request-id correlation."}]},"timestamp":"2024-01-03T00:01:00Z"}
FIXTURE
```

| Step | Command | Expected |
|------|---------|----------|
| 7.1 | Create curate fixture (above) | File exists |
| 7.2 | `lcm import $LCME2E_DIR/e2e-curate.jsonl --cwd $LCME2E_DIR` | Exit 0 |
| 7.3 | `lcm compact --all --cwd $LCME2E_DIR` | Exit 0 |
| 7.4 | `lcm promote --cwd $LCME2E_DIR` | Exit 0 |
| 7.5 | `lcm status --json --cwd $LCME2E_DIR` | `promoted` count ≥ previous flow value |

**Pass criteria:** All three stages exit 0, promoted count non-decreasing.

---

## Flow 8 — Retrieval

**Goal:** Verify search, grep, expand, and describe operations return relevant results.

| Step | Command | Expected |
|------|---------|----------|
| 8.1 | `lcm search "SQLite database" --cwd $LCME2E_DIR` | Returns ≥ 1 result mentioning SQLite |
| 8.2 | `lcm search "JWT authentication" --cwd $LCME2E_DIR` | Returns ≥ 1 result mentioning JWT |
| 8.3 | `lcm search "nonexistent-xyzzy-term" --cwd $LCME2E_DIR` | Returns 0 results or empty (no crash) |
| 8.4 | `lcm search "SQLite" --format json --cwd $LCME2E_DIR` | Valid JSON array output |

**Pass criteria:** Steps 8.1 and 8.2 return results; 8.3 does not crash; 8.4 produces valid JSON.

---

## Flow 9 — Restore (SessionStart Hook)

**Goal:** Verify the SessionStart hook returns context for a new session.

| Step | Command | Expected |
|------|---------|----------|
| 9.1 | `lcm hook session-start --cwd $LCME2E_DIR` | Exit 0, returns context JSON or markdown block |
| 9.2 | Output contains memory content | Response references at least one stored memory |

**Pass criteria:** Hook exits 0, returns non-empty context referencing prior conversations.

---

## Flow 10 — UserPromptSubmit Hook

**Goal:** Verify the UserPromptSubmit hook returns memory hints for a relevant prompt.

| Step | Command | Expected |
|------|---------|----------|
| 10.1 | `lcm hook user-prompt-submit --prompt "What database are we using?" --cwd $LCME2E_DIR` | Exit 0, returns hint about SQLite |
| 10.2 | `lcm hook user-prompt-submit --prompt "xyzzy irrelevant" --cwd $LCME2E_DIR` | Exit 0, returns empty or minimal hint (no crash) |

**Pass criteria:** Both commands exit 0; 10.1 returns relevant hint.

---

## Flow 11 — MCP Transport

**Goal:** Verify all 7 MCP tools respond without error.

| Step | Command | Expected |
|------|---------|----------|
| 11.1 | `lcm mcp ping` | Exit 0, returns `pong` or health OK |
| 11.2 | `lcm mcp list-tools` | Lists ≥ 7 tool names |
| 11.3 | `lcm mcp call lcm_search '{"query":"SQLite"}' --cwd $LCME2E_DIR` | Returns result JSON |
| 11.4 | `lcm mcp call lcm_status '{}' --cwd $LCME2E_DIR` | Returns status JSON |
| 11.5 | `lcm mcp call lcm_compact '{}' --cwd $LCME2E_DIR` | Exit 0 |
| 11.6 | `lcm mcp call lcm_promote '{}' --cwd $LCME2E_DIR` | Exit 0 |
| 11.7 | `lcm mcp call lcm_doctor '{}' --cwd $LCME2E_DIR` | Returns health report |

**Pass criteria:** All 7 MCP calls exit 0 and return non-empty output.

---

## Flow 12 — Doctor

**Goal:** `lcm doctor` reports all checks healthy.

| Step | Command | Expected |
|------|---------|----------|
| 12.1 | `lcm doctor` | Exit 0 |
| 12.2 | Output contains no FAIL or ERROR lines | Zero failures in report |
| 12.3 | Daemon check | Shows daemon as running |
| 12.4 | Hooks check | Shows hooks as registered |
| 12.5 | MCP check | Shows MCP server as reachable |

**Pass criteria:** Exit 0, no FAIL/ERROR in output, all subsystems healthy.

---

## Flow 13 — Teardown

**Goal:** Remove temp directory and associated project data. Always runs at end of full suite.

| Step | Command | Expected |
|------|---------|----------|
| 13.1 | `PROJECT_HASH=$(lcm status --json --cwd $LCME2E_DIR \| jq -r '.projectHash // empty')` | Hash extracted or empty |
| 13.2 | `rm -rf $LCME2E_DIR` | Temp dir removed |
| 13.3 | `[ -n "$PROJECT_HASH" ] && rm -rf ~/.lossless-claude/projects/$PROJECT_HASH` | Project data removed (if hash known) |
| 13.4 | `ls /tmp/lcm-e2e-test-* 2>/dev/null` | No lcm-e2e-test dirs remain |

**Pass criteria:** Temp dir gone, project data cleaned up.

---

## Flow 14 — SessionEnd Hook

**Goal:** Verify the SessionEnd hook ingests session data via hook trigger.

| Step | Command | Expected |
|------|---------|----------|
| 14.1 | Create a fresh temp dir: `HOOK_DIR=$(mktemp -d /tmp/lcm-e2e-test-XXXXXX)` | Dir created |
| 14.2 | `lcm hook session-end --transcript '{"messages":[{"role":"user","content":"hook test"},{"role":"assistant","content":"hook response stored"}]}' --cwd $HOOK_DIR` | Exit 0 |
| 14.3 | `lcm status --json --cwd $HOOK_DIR` | `conversations` count ≥ 1 |
| 14.4 | `rm -rf $HOOK_DIR` | Cleanup |

**Pass criteria:** Hook exits 0, conversation recorded in isolated project.

---

## Flow 15 — PreCompact Hook

**Goal:** Verify the PreCompact hook returns exit code 2 to signal Claude to proceed.

| Step | Command | Expected |
|------|---------|----------|
| 15.1 | `lcm hook pre-compact --cwd $LCME2E_DIR` | Exit code 2 (not 0 or 1) |
| 15.2 | Output contains memory summary or context | Non-empty stdout |

**Pass criteria:** Exit code is exactly 2, stdout is non-empty.

---

## Flow 16 — Auto-heal (Read-only in Live Mode)

**Goal:** Verify hooks are registered in Claude Code config. READ-ONLY — does not modify hooks.

| Step | Command | Expected |
|------|---------|----------|
| 16.1 | `lcm hooks list` | Lists registered hooks |
| 16.2 | Output contains `session-start` | SessionStart hook present |
| 16.3 | Output contains `session-end` | SessionEnd hook present |
| 16.4 | Output contains `pre-compact` | PreCompact hook present |
| 16.5 | Output contains `user-prompt-submit` | UserPromptSubmit hook present |

**Pass criteria:** All 4 hook types are registered. No modifications made.

---

## Flow 17 — Scrubbing

**Goal:** Verify sensitive patterns are redacted before storage.

```bash
cat > $LCME2E_DIR/e2e-sensitive.jsonl << 'FIXTURE'
{"type":"human","message":{"role":"user","content":[{"type":"text","text":"The API key is sk-1234567890abcdef and the password is hunter2. Connect via postgres://admin:secret@localhost/db"}]},"timestamp":"2024-01-04T00:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll help you configure the connection. I've noted the credentials."}]},"timestamp":"2024-01-04T00:01:00Z"}
FIXTURE
```

| Step | Command | Expected |
|------|---------|----------|
| 17.1 | Create sensitive fixture (above) | File created |
| 17.2 | `lcm import $LCME2E_DIR/e2e-sensitive.jsonl --cwd $LCME2E_DIR` | Exit 0 |
| 17.3 | `lcm search "sk-1234" --cwd $LCME2E_DIR` | Returns 0 results (key redacted) |
| 17.4 | `lcm search "hunter2" --cwd $LCME2E_DIR` | Returns 0 results (password redacted) |
| 17.5 | `lcm search "postgres://admin" --cwd $LCME2E_DIR` | Returns 0 results (connection string redacted) |

**Pass criteria:** None of the 3 sensitive patterns are findable via search.

---

## Flow 18 — Daemon-down Resilience

**Goal:** Hooks fail gracefully when daemon is not running.

| Step | Command | Expected |
|------|---------|----------|
| 18.1 | `lcm daemon stop` | Daemon stops (or already stopped) |
| 18.2 | `lcm hook session-start --cwd $LCME2E_DIR` | Exits non-zero OR exits 0 with empty/fallback context (no crash/hang) |
| 18.3 | `lcm hook user-prompt-submit --prompt "test" --cwd $LCME2E_DIR` | Exits non-zero OR exits 0 with empty hint (no crash/hang) |
| 18.4 | `lcm daemon start --detach` | Daemon restarts successfully |
| 18.5 | `lcm status --json` | Daemon running again |

**Pass criteria:** Hooks do not crash or hang when daemon is down; daemon restarts cleanly.

---

## Flow 19 — Status

**Goal:** `lcm status` returns correct state fields.

| Step | Command | Expected |
|------|---------|----------|
| 19.1 | `lcm status` | Exit 0, human-readable output |
| 19.2 | `lcm status --json` | Exit 0, valid JSON |
| 19.3 | JSON contains `daemon` field | `daemon` is `"running"` |
| 19.4 | JSON contains `version` field | Non-empty version string |
| 19.5 | JSON contains `projects` or `projectCount` field | Numeric value ≥ 0 |

**Pass criteria:** Both plain and JSON output succeed, all expected fields present.

---

## Summary Table

Fill in ✓ (pass) or ✗ (fail) after running each flow. Add notes for any failures.

| Flow | Status | Notes |
|------|--------|-------|
| 1 — Environment | ✓ / ✗ | |
| 2 — Import | ✓ / ✗ | |
| 3 — Idempotent re-import | ✓ / ✗ | |
| 4 — Subagent import | ✓ / ✗ | |
| 5 — Compact | ✓ / ✗ | |
| 6 — Promote | ✓ / ✗ | |
| 7 — Curate | ✓ / ✗ | |
| 8 — Retrieval | ✓ / ✗ | |
| 9 — Restore (SessionStart) | ✓ / ✗ | |
| 10 — UserPromptSubmit | ✓ / ✗ | |
| 11 — MCP transport | ✓ / ✗ | |
| 12 — Doctor | ✓ / ✗ | |
| 13 — Teardown | ✓ / ✗ | |
| 14 — SessionEnd hook | ✓ / ✗ | |
| 15 — PreCompact hook | ✓ / ✗ | |
| 16 — Auto-heal | ✓ / ✗ | |
| 17 — Scrubbing | ✓ / ✗ | |
| 18 — Daemon-down resilience | ✓ / ✗ | |
| 19 — Status | ✓ / ✗ | |

**Result:** _N/19 flows passed_
