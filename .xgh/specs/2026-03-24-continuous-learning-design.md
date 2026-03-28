# Continuous Mid-Session Learning for lcm

**Date:** 2026-03-24
**Status:** Draft
**Related:** #90 (compact --hook flag), #94 (duplicate hooks on upgrade)

## Problem

Promotion is compact-gated today. Insights from short sessions (below `autoCompactMinTokens`) never get promoted. Mid-session insights are invisible to the memory system until the session closes. If a session crashes before SessionEnd, everything is lost.

## Approach: Instruction + Stop Hook Safety Net (Approach B)

Two complementary capture paths:

| Path | Mechanism | Signal | Latency |
|------|-----------|--------|---------|
| **Intentional** | CLAUDE.md instruction → Claude calls `lcm_store` | High (curated) | Immediate (same turn) |
| **Safety net** | Stop hook → rolling ingest via `transcript_path` | Raw (full transcript) | ≤60 seconds |
| **Finalization** | SessionEnd → flush + compact + promote | Medium (summarized) | Session close |

### Path 1: `lcm_store` via instruction

`lcm_store` is an **existing** MCP tool (defined in `src/mcp/tools/lcm-store.ts`, handled by `src/daemon/routes/store.ts`). It writes directly to the `promoted` table in SQLite with confidence 1.0. No changes to the tool itself are needed — this path only adds the instruction that tells Claude when to use it.

Claude is instructed (via UserPromptSubmit injection) to call `lcm_store` when recognizing one of 7 categories:

| Category | Store when... |
|----------|--------------|
| decision | Architectural/design choice with trade-offs |
| preference | User working style or tool preference revealed |
| root-cause | Bug cause that took real effort to uncover |
| pattern | Codebase convention not documented elsewhere |
| gotcha | Non-obvious pitfall or footgun |
| solution | Non-trivial fix worth remembering |
| workflow | Multi-step process or operational sequence that works |

**Delivery:** Injected as `<learning-instruction>` block by the UserPromptSubmit hook, alongside the existing `<memory-context>` block. This survives context compaction (refreshed every turn) and requires zero setup — works the moment the plugin loads.

**Usage:** `lcm_store(text: "concise insight with why", tags: ["category:decision"])`

Writes directly to the `promoted` table — immediately searchable via UserPromptSubmit retrieval in the same session.

### Path 2: Stop hook → rolling ingest

A Stop hook fires after every Claude response. It sends a lightweight ingest request to the daemon, pointing at the on-disk transcript file. The daemon's existing `/ingest` endpoint reads the file and applies its built-in delta logic (`storedCount + slice`) to process only new messages.

**Handler:** `lcm session-snapshot`

**Transcript access:** Claude Code hooks receive a JSON blob on stdin containing `session_id`, `cwd`, and `transcript_path` (the path to the JSONL session file on disk). The `session-snapshot` handler extracts these fields and POSTs `{ session_id, cwd, transcript_path }` to the daemon's `/ingest` endpoint. The daemon reads the file via `resolveMessages()` and only processes messages beyond `storedCount` — this is existing behavior (see `ingest.ts` lines 70-71).

**Throttling:**
```
On Stop hook fire:
  1. Parse stdin → extract session_id (UUID format, path-safe)
  2. Stat /tmp/lcm-snap-{session-id}.json for mtime (single syscall, no file read)
  3. If mtime exists and now - mtime < snapshotIntervalSec (default 60) → exit 0 (skip)
  4. POST /ingest with { session_id, cwd, transcript_path } from stdin (5s timeout)
  5. Touch cursor file (write { ts: now })
  Missing cursor → POST /ingest, create cursor
  Timeout/error → log to auto-heal.log, exit 0 (never block Claude)
```

**Throttle-first design:** The timestamp check (step 2-3) uses `fs.statSync` on the cursor file's mtime — a single syscall with no file read. This is cheaper than reading and parsing JSON, and ensures throttled invocations exit immediately with zero I/O beyond the stat call.

**Cursor files:** One per session in `/tmp/lcm-snap-{session-id}.json` where `session-id` is the Claude Code session UUID (path-safe by definition). Contains `{ "ts": <epoch> }`. Purpose is throttling only — the daemon handles delta tracking internally via `storedCount`. These files are ephemeral; ingestion state (whether a session has been fully processed) lives in SQLite, not the cursor file. Session UUIDs are unique, so a new session never inherits a stale cursor.

**Why `transcript_path`, not message payload:** The hook sends only a file path (~100 bytes), not the transcript content. The daemon reads the file directly. This keeps the HTTP payload O(1) regardless of session length. The daemon's existing delta logic (`parsed.slice(storedCount)`) ensures each message is stored exactly once — no new endpoint or dedup logic needed.

**No new daemon endpoint required.** The existing `POST /ingest` handles everything: it accepts `transcript_path`, reads the file, and only stores messages it hasn't seen. This was validated by reading `ingest.ts`.

**`snapshotIntervalSec` config:** Lives in `config.hooks.snapshotIntervalSec` (new section in DaemonConfig). Default: 60. Configurable in `~/.lossless-claude/config.json`.

### Path 3: SessionEnd (enhanced)

**Changes from today:**
1. **Ingest becomes a final flush** — catches messages after the last snapshot
2. **Always compact** — the `autoCompactMinTokens` threshold is removed. Short sessions are cheap to compact; gating them was marginal savings for real information loss.
3. **Always promote** — runs after compact regardless
4. **Records completion** — writes session ID + timestamp + message count to SQLite ingestion manifest
5. **Cursor file** — left to OS `/tmp` cleanup (no longer deleted by SessionEnd)

**Updated flow:**
```
SessionEnd fires:
  1. POST /ingest (final flush — daemon's delta logic handles overlap with snapshots)
  2. POST /compact (always — threshold removed)
  3. POST /promote (always)
  4. Record session as fully ingested in SQLite manifest
```

**`autoCompactMinTokens` deprecation:** The config field is preserved for backwards compatibility but the threshold check in SessionEnd is removed. Users who previously set it to 0 to disable auto-compact should use the new `hooks.disableAutoCompact: true` flag instead (documented in migration notes). The default behavior changes from "compact only if above threshold" to "always compact."

**`lcm import` idempotency:** The `lcm import` command checks the SQLite ingestion manifest before processing. Sessions already marked as fully ingested are skipped. This makes import fast and safe to re-run.

## Lazy Bootstrap

**Problem:** Plugin install via marketplace never calls `install()`. Users expect lcm to "just work" after `/reload-plugins`.

**Solution:** Every hook handler calls `ensureBootstrapped()` before doing its work:

```
ensureBootstrapped(sessionId: string):
  if /tmp/lcm-bootstrapped-{sessionId}.flag exists → return
  ensureCore()
  write flag file

ensureCore():                    ← shared with install()
  1. Create ~/.lossless-claude/config.json with defaults if missing
  2. mergeClaudeSettings() — clean stale/duplicate hooks (fixes #94)
  3. Start daemon if not running

install():                       ← standalone power-user path
  ensureCore()
  + pickSummarizer() (interactive)
  + copy slash commands
  + run doctor
```

**`ensureCore()` and #94:** The `mergeClaudeSettings()` call in `ensureCore()` cleans up duplicate/stale hooks left by upgrades. This runs on every first hook fire, fixing #94 for both plugin and standalone installs without requiring the user to manually run `lcm install`.

## Plugin Registration

**Stop hook in plugin.json:**
```json
"Stop": [{
  "matcher": "",
  "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" session-snapshot" }]
}]
```

**Hook changes summary:**
- **Stop** — new hook registration (rolling ingest)
- **UserPromptSubmit** — handler updated to inject `<learning-instruction>` block
- **SessionEnd** — handler updated to always compact + promote, record ingestion manifest
- **SessionStart, PreCompact** — no changes to registration or handlers
- **All hooks** — `ensureBootstrapped()` wrapper added at entry point

## Error Handling

**Principle:** Hooks must never block Claude. Every handler wraps work in try/catch, logs errors to `~/.lossless-claude/auto-heal.log`, exits 0.

| Scenario | Behavior |
|----------|----------|
| Daemon down mid-session | Stop/UserPromptSubmit fail silently, log error. Next `ensureBootstrapped()` respawns daemon. |
| Concurrent sessions | Separate cursor files. SQLite WAL mode handles concurrent writes. |
| `/reload-plugins` mid-session | No cursor → first Stop fire POSTs to `/ingest` (daemon deduplicates via storedCount), creates cursor. |
| Session crash (user force-quit) | Content up to last snapshot (≤60s) already ingested. Only the final minute is lost. |
| Daemon crash mid-session | Stop hook's next POST fails (logged, skipped). When daemon restarts, `storedCount` reflects what was actually persisted — next successful ingest picks up from the daemon's true state, not the cursor's. |
| `lcm_store` MCP failure | Claude sees error. Insight still in transcript → Stop hook captures it. Safety net works. |
| Fast exchanges | Throttle skips most Stop fires. At most one ingest per 60 seconds. |
| First-ever session | `ensureBootstrapped()` → `ensureCore()` creates config, starts daemon. Transparent. |

**Timeouts:** All daemon HTTP calls in hook handlers have a 5-second hard timeout. On timeout: log to `~/.lossless-claude/auto-heal.log`, exit 0. The next Stop fire will retry (daemon's `storedCount` ensures no data loss from skipped calls).

## Quality Validation

**Concern:** Category-driven storage must produce useful promotions, not noise.

**Synthetic session test:** A scripted session transcript exercising all 7 categories with realistic dialogue:

```
Synthetic session contains:
  - A decision with trade-offs (chose SQLite over Postgres)
  - A user preference revealed naturally ("I prefer small PRs")
  - A root-cause diagnosis after debugging
  - A codebase pattern discovered
  - A gotcha/footgun encountered
  - A non-trivial solution
  - A workflow sequence

Assertions after pipeline runs:
  ✓ At least 1 promoted entry per category (LLM behavior is non-deterministic — "at least 1" not "exactly 1")
  ✓ Promoted text is concise (< 3 sentences)
  ✓ Promoted text includes the "why", not just "what"
  ✓ No noise entries (greetings, status updates, trivial Q&A)
  ✓ Noise ratio < 20% (non-category entries / total entries)
  ✓ Retrieval finds them (UserPromptSubmit search returns relevant hits)
```

**Test levels:**

| Level | What | How |
|-------|------|-----|
| Unit | `ensureCore()`, throttle logic (stat-based), `session-snapshot` handler, SessionEnd changes, UserPromptSubmit `<learning-instruction>` injection | Mocked deps, existing test patterns |
| Integration | `lcm_store` → promoted table → UserPromptSubmit retrieval in same session | Real daemon, verify round-trip |
| E2E: `lcm_store` path | Synthetic session → `lcm_store` calls → quality assertions on promoted entries | `test/e2e/continuous-learning.test.ts` |
| E2E: rolling ingest path | Synthetic session → Stop hook snapshots → compact → promote → quality assertions | Same test file, separate describe block |
| Failure mode | MCP down → `lcm_store` fails → Stop hook still captures → content eventually promoted | Daemon kill + restart during synthetic session |

**SQLite migration:** The new ingestion manifest table (`session_ingest_log`) is added via the existing `runLcmMigrations()` framework. Schema: `session_id TEXT PRIMARY KEY, completed_at TEXT, message_count INTEGER`. Applied automatically on first daemon request to a project database — no manual migration step needed.

## Scope Summary

| Item | New / Changed | Fixes |
|------|--------------|-------|
| `ensureCore()` extracted from `install()` | New shared function | #94 |
| `ensureBootstrapped(sessionId)` in every hook | New wrapper (session-scoped flag file) | — |
| `lcm session-snapshot` subcommand | New CLI command | — |
| Stop hook registration in plugin.json | New hook | — |
| UserPromptSubmit `<learning-instruction>` injection | Changed | — |
| SessionEnd: remove threshold, always compact + promote | Changed | — |
| `hooks.snapshotIntervalSec` config field | New config field (default 60) | — |
| `hooks.disableAutoCompact` config field | New config field (migration path) | — |
| SQLite ingestion manifest table | New table | — |
| `lcm import` idempotency check | Changed | — |
| Synthetic session quality test | New test | — |
