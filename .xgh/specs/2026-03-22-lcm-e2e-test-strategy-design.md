# E2E Test Strategy for lossless-claude/lcm

**Date:** 2026-03-22
**Status:** Approved
**Approach:** Unified test harness with mode flag (Approach 1)
**Validated by:** Codex (gpt-5.4), Claude Opus 4.6

---

## Context

lossless-claude (lcm) is a Claude Code plugin providing persistent memory via a daemon, hooks, MCP tools, and SQLite storage.

**Current daemon routes (10):** ingest, store, search, compact, restore, expand, describe, grep, prompt-search, recent.
**New routes added by this work (2):** `/promote`, `/status`.
**Current CLI:** `lcm status` exists but only checks `/health` and prints daemon up/down. This work enhances it significantly.

Current state: 51 test files, 423 unit tests — all mock-based. No integration or E2E tests exist.

This spec defines an E2E test strategy that:
- Dogfoods the full plugin integration: hooks, memory storage, retrieval, promotion
- Produces deterministic results in CI (mock mode)
- Validates real installations in live mode (user-facing skill)
- Never touches user data in live mode

## Architecture: Unified Harness with Mode Flag

A single test harness runs the same flows in two modes:

- **`mock`** (default): Fake summarizer returning canned responses. Runs in Vitest, deterministic, CI-safe. Ships a `.jsonl` fixture.
- **`live`**: Real LLM. Same flows, relaxed assertions (structure not exact content). Run manually via `/lcm-e2e` skill.

### Harness Shape

`createHarness(mode)` returns a `HarnessHandle`:

```typescript
interface HarnessHandle {
  tmpDir: string;          // isolated temp directory for test data
  dbPath: string;          // test SQLite path
  daemonPort: number;      // test port (randomized in mock, user's port in live)
  client: DaemonClient;    // production DaemonClient from src/daemon/client.ts (dogfooding)
  fixturePath: string;     // path to .jsonl fixture
  mode: "mock" | "live";
  cleanup(): Promise<void>;
}
```

The `client` uses the production `DaemonClient` — not a test wrapper — to maximize real-code coverage.

**Lifecycle:**
1. `createHarness()` — creates temp dir, picks free port (mock) or uses existing daemon (live), copies fixture, starts daemon with test config
2. Flows run as pure functions: `(handle: HarnessHandle) => Promise<FlowResult>`
3. `handle.cleanup()` — stops daemon (mock), removes temp dir, frees port

### Mock/Live Seam

Only the summarizer is swapped between modes. Everything else — daemon HTTP, hook dispatch, SQLite, FTS5, MCP transport — is real in both modes.

The summarizer DI is implemented via a config-level override (`summarizer.mock: true`) that the compact handler checks. When set, it uses a `MockSummarizer` that returns structurally valid canned summaries.

## Prerequisites (Production Code Changes)

### 1. Summarizer DI Injection Point

`createCompactHandler` currently builds the summarizer internally from config. Add a config-level `summarizer.mock: true` override. When set, the compact route uses a `MockSummarizer` that returns canned but structurally valid summaries (correct shape, reasonable token counts, stable text).

### 2. `lcm promote` CLI Subcommand + `/promote` Daemon Route

Currently promotion is a side-effect inside compact. Extract it into:
- New daemon route: `POST /promote`
  - Accepts: `{ cwd: string, dry_run?: boolean }`
  - Iterates summaries from the project's `SummaryStore`, calls `shouldPromote(summaryContent)` on each
  - For promotable summaries, calls `deduplicateAndInsert()` which returns a string ID (it internally decides whether to insert fresh, merge into existing, or archive)
  - Returns: `{ processed: number, promoted: number }` — we intentionally do NOT expose merged/archived counts in v1 since `deduplicateAndInsert()` hides that distinction. The route's contract matches what the current primitives can report.
  - **Future enhancement:** If `deduplicateAndInsert()` is later refactored to return action metadata (insert/merge/archive), the route response can be enriched without breaking the initial contract.
- New CLI subcommand: `lcm promote [--all] [--verbose] [--dry-run]`
- Compact route no longer runs promotion automatically
- `/lcm-curate` calls import → compact → promote sequentially

**Scope note:** This is the largest prerequisite. The current coupling between compaction and promotion in `src/daemon/routes/compact.ts` needs to be untangled. The promotion logic itself (`detector.ts`, `dedup.ts`) is already modular — the work is in extracting the orchestration out of the compact handler into a standalone route handler.

### 3. Enhance `lcm status` CLI Subcommand + New `/status` Daemon Route

`lcm status` already exists (checks `/health`, prints daemon up/down + provider). This work enhances it with a richer `/status` route returning:
- Daemon uptime, port, PID
- Current project: message count, summary count, promoted count
- Last ingest/compact/promote timestamps
- Config: autoCompactMinTokens threshold, summarizer provider

The existing `lcm status` behavior is preserved as a subset — the enhancement is backward-compatible.

**Implementation note:** Currently only `lastCompact` is persisted. The `/status` route will need to add timestamp tracking for ingest and promote operations. This can be done via a simple `project_meta` table or by extending the existing `meta.json` file.

## Plugin Commands

Six commands, all thin wrappers over CLI. New functionality always goes in the CLI first.

### `/lcm-import` (update existing)
- Wraps: `lcm import`
- Params: `--all`, `--verbose`, `--dry-run`
- Output: Session count, message count, skipped/failed

### `/lcm-compact` (new)
- Wraps: `lcm compact --all` (batch mode, not the hook dispatch path)
- Params: `--all` (default), `--verbose`, `--dry-run`
- Output: Summary count, DAG depth, token savings
- **Note:** `lcm compact` without `--all` falls through to hook dispatch (`dispatchHook("compact", ...)`), which is the PreCompact hook path. The plugin command always uses the batch path.

### `/lcm-promote` (new)
- Wraps: `lcm promote`
- Params: `--all`, `--verbose`, `--dry-run`
- Output: Processed count, promoted count

### `/lcm-curate` (new)
- Wraps: `lcm import` → `lcm compact` → `lcm promote` sequentially
- Params: `--all`, `--verbose`, `--dry-run`
- Output: Combined report from all three phases
- **Error propagation:** Stops on first phase failure and reports which phase failed. Does not continue to compact if import fails, or to promote if compact fails.

### `/lcm-status` (new)
- Wraps: `lcm status`
- Params: `--json`
- Output: Daemon state, project stats, last operation timestamps

### `/lcm-e2e` (new skill)
- Wraps: the shared E2E harness
- Args: flow name or empty for full suite
- Mode: always `--live` when run as skill
- Output: Per-flow pass/fail table

## E2E Flows (19 total)

### Pipeline Phase Flows

| # | Flow | Validates | Mock Assertions | Live Assertions |
|---|------|-----------|-----------------|-----------------|
| 1 | Environment | Daemon starts, version check | Exact version string | Same |
| 2 | Import | Replay fixture → messages in SQLite | Exact message count, roles, token totals | Same |
| 3 | Idempotent re-import | Re-run import → no duplicates | `ingested: 0` | Same |
| 4 | Subagent import | `subagents/*.jsonl` discovered | Subagent session found + ingested | Same |
| 5 | Compact | Compaction → DAG summary nodes | Summary rows exist, depth > 0 | Same + coherent text |
| 6 | Promote | Promotion → promoted memories in FTS5 | Promoted row exists | Same + reasonable tags/content |
| 7 | Curate | Full pipeline (import → compact → promote) | All prior assertions combined | Same |

### Retrieval Flows

| # | Flow | Validates | Mock Assertions | Live Assertions |
|---|------|-----------|-----------------|-----------------|
| 8 | Retrieval | lcm_search, lcm_grep, lcm_expand, lcm_describe | Non-empty results, correct structure | Same + relevant content |
| 9 | Restore | SessionStart hook returns context | Stdout contains context tags | Same |
| 10 | UserPromptSubmit | Hook hits /prompt-search, surfaces promoted memory | Returns `<memory-context>` hints | Same |

### Infrastructure Flows

| # | Flow | Validates | Mock Assertions | Live Assertions |
|---|------|-----------|-----------------|-----------------|
| 11 | MCP transport | All 7 tools: daemon-backed (grep, search, expand, describe, store) return JSON via daemon routes; local-only (stats, doctor) return plain text computed in-process. | Daemon tools: valid JSON structure. Local tools: non-empty text, no error strings. | Same |
| 12 | Doctor | lcm_doctor reports healthy | All checks pass | Same |
| 13 | Teardown | Tear down test DB, stop daemon | Temp dir removed, port freed | Same |

### Hook Flows

| # | Flow | Validates | Mock Assertions | Live Assertions |
|---|------|-----------|-----------------|-----------------|
| 14 | SessionEnd hook | Fires /ingest + auto-compact trigger. **Note:** In the current codebase, SessionEnd fires compact which includes promotion as a side-effect. After prerequisite 2 lands, compact will no longer trigger promotion — SessionEnd will fire compact only. The E2E flow tests the post-prerequisite behavior. | Messages stored, compact fires above threshold | Same |
| 15 | PreCompact hook | Exit code 2 replaces native compaction | Exit 2 + summary in stdout | Same |

### Resilience Flows

| # | Flow | Validates | Mock Assertions | Live Assertions |
|---|------|-----------|-----------------|-----------------|
| 16 | Auto-heal | Hook self-repair of missing registrations | Hooks restored after deliberate break | Read-only verify (live) |
| 17 | Scrubbing | ScrubEngine redacts sensitive patterns | Stored content has no API key patterns | Same |
| 18 | Daemon-down resilience | Hooks fail gracefully when daemon unreachable | All hooks exit 0, no crash | Same |
| 19 | Status | lcm status returns correct state | Correct counts after each phase | Same |

### Flow Dependencies

```
1 (Environment)
└→ 2 (Import)
   ├→ 3 (Idempotent re-import)
   ├→ 4 (Subagent import)
   └→ 5 (Compact)
      └→ 6 (Promote)
         └→ 7 (Curate)
            ├→ 8 (Retrieval)         ─┐
            ├→ 9 (Restore)           │
            ├→ 10 (UserPromptSubmit) │ independent after 7
            ├→ 11 (MCP transport)    │
            ├→ 12 (Doctor)           │
            ├→ 14 (SessionEnd hook)  │
            ├→ 15 (PreCompact hook)  │
            ├→ 16 (Auto-heal)       │
            ├→ 17 (Scrubbing)       │
            ├→ 18 (Daemon-down)     │
            └→ 19 (Status)          ─┘
13 (Teardown) — always runs last, even on failure
```

## Fixture Design

### Location

```
test/fixtures/e2e/
  session-main.jsonl          # 15-20 messages, realistic conversation
  subagents/
    subagent-task-1.jsonl     # 5 messages, subagent transcript
```

This mirrors Claude Code's session directory layout, where subagent transcripts live in a `subagents/` subdirectory under the parent session.

**Scope note:** The `--all` flag (multi-project import) is not tested in the E2E suite because the isolated harness only creates one temp project. Multi-project behavior is covered by existing unit tests in `test/import.test.ts`.

### Content Requirements

| Property | Purpose |
|----------|---------|
| Mix of user/assistant/system/tool roles | Tests role filtering in transcript parser |
| At least one `tool_result` content block | Tests content block extraction |
| Enough tokens to exceed `autoCompactMinTokens` | Triggers auto-compact in SessionEnd flow |
| Contains fake API key pattern (`sk-test-abc123...`) | Verifies scrub engine redaction |
| Contains durable insight pattern (decision, architecture choice) | Gives promotion detector material in live mode |
| Deterministic content — no timestamps/UUIDs in message text | Keeps structural assertions stable |

### Assertion Strategy

| Type | Mock | Live |
|------|------|------|
| Row counts (messages, summaries, promoted) | Exact | Minimum bounds |
| Structure (columns, types, non-null) | Exact | Exact |
| Content (summary text, promoted tags) | Skipped | Plausibility (non-empty, reasonable length) |
| Ordering (seq numbers) | Exact | Exact |
| DAG depth | Exact | Minimum bounds (leaf count depends on summarizer grouping) |
| Absence (no duplicates, scrubbed patterns gone) | Exact | Exact |

The fixture is structural input, never a golden oracle. Never assert exact summary text, exact promoted content, or exact BM25 ranks.

## `/lcm-e2e` Skill Design

### Argument Routing

| Argument | Flows |
|----------|-------|
| *(empty)* | All 19 |
| `import` | 1, 2, 3, 4 |
| `compact` | 1, 2, 5 |
| `promote` | 1, 2, 5, 6 |
| `curate` | 1, 2, 5, 6, 7 |
| `retrieval` | 1, 2, 5, 6, 8 |
| `hooks` | 1, 2, 9, 10, 14, 15, 16, 18 |
| `doctor` | 1, 11, 12, 19 |
| `cleanup` | 13 only |

### Safety: Live Mode Data Isolation

**Invariant:** Live mode never touches user data.

1. **Isolated `cwd`** — Uses a temp directory prefixed with `e2e-test-` as `cwd`. `projectId()` hashes the absolute path, creating a completely separate project database under `~/.lossless-claude/projects/<temp-hash>/`.
2. **Existing daemon** — Uses the user's running daemon (multi-project). Isolated `cwd` routes all operations to the sandbox database.
3. **Auto-heal is read-only in live mode** — Verifies hooks are registered, does not deliberately break `settings.json`.
4. **Cleanup removes sandbox** — Deletes `~/.lossless-claude/projects/<temp-hash>/` entirely.
5. **Defensive cleanup** — Cleanup runs as first step of next run to handle prior crash orphans.
6. **Orphan detection** — `lcm doctor` can detect and flag orphaned `e2e-test-` projects.

### Output Format

```
| Flow | Status | Notes |
|------|--------|-------|
| 1 — Environment | pass | lcm 0.1.0, daemon on :3737 |
| 2 — Import | pass | 15 messages ingested |
| 3 — Idempotent re-import | pass | ingested: 0 |
| ... | | |
```

## Approaches Considered

### Approach 1: Unified harness with mode flag (CHOSEN)
Single harness, mock/live toggle on summarizer only. One set of flows, no drift.

### Approach 2: Separate suites, shared fixtures (REJECTED)
Two independent suites with shared fixture. Rejected: assertions drift, bug fixes in two places.

### Approach 3: CLI-first with test wrapper (REJECTED)
E2E as `lcm e2e` CLI subcommand. Rejected: heavyweight, conflates test infra with product surface.

## Codex Review Feedback (Incorporated)

- Added 5 missing flows: Restore, UserPromptSubmit, Idempotent re-import, Subagent import, MCP transport split
- Harness shape: `createHarness()` → `HarnessHandle`, not a mutable class
- Mock/live defined as "summarizer + assertion strictness", not two harnesses
- Fixture treated as structural input, not golden oracle
- Promotion in mock mode: only structural invariants, never exact content
- Kept `/lcm-import` naming (dropped `/lcm-sync` — vocabulary mismatch)
- Identified DI gap in `createCompactHandler` as prerequisite

## Spec Review Feedback (Incorporated)

**Critical fixes:**
- C1: Clarified route counts — 10 existing + 2 new (`/promote`, `/status`)
- C2: Added `/promote` route interface definition and scope note on extraction work
- C3: Clarified `lcm compact` vs `lcm compact --all` behavior — plugin command uses batch path

**Important fixes:**
- I1: Noted `--all` multi-project testing as out of scope (covered by unit tests)
- I2: Clarified `lcm status` is an enhancement of existing command, not brand new
- I3: Specified all 7 MCP tools tested in Flow 11 with response shape validation
- I4: Clarified SessionEnd auto-compact is compact-only (promotion decoupled)
- I5: Added `lcm_describe` to Flow 8 (Retrieval)

**Minor fixes:**
- M1: Renamed Flow 13 from "Cleanup" to "Teardown"
- M2: Clarified harness uses production `DaemonClient`
- M3: Added error propagation behavior for `/lcm-curate`
- M4: Added note that fixture layout mirrors Claude Code's session directory
- M5: Changed DAG depth assertion to minimum bounds in live mode
