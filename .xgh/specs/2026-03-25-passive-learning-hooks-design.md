# Passive Learning Hooks for LCM

**Date:** 2026-03-25
**Status:** Draft
**Authors:** Pedro Almeida, Claude

## Problem

LCM relies entirely on explicit `lcm_store()` calls from the LLM to capture durable insights. This requires the LLM to recognize what's worth storing and act on it — a bet on model judgment that misses many valuable signals. User decisions, error→fix patterns, workflow preferences, and project conventions often go uncaptured.

Context-mode demonstrates that passive event capture via hooks (PostToolUse, UserPromptSubmit) can extract structured events from every tool call at zero LLM cost. LCM should adopt this pattern for its cross-session semantic memory pipeline.

## Design Principles

- **Self-sufficient** — LCM must work standalone without context-mode. When both are installed, they operate independently (no coordination, no detection).
- **Lossless philosophy** — Per lossless-claude's design principle, inspired by Voltropy's lossless retrievability model: nothing is ever deleted. Confidence reflects truth/quality, not temporal relevance. Recency is applied at query time only. Staleness is handled by contradiction detection, not time-based decay. (Note: the Voltropy LCM paper covers lossless retrievability and compaction, not confidence scoring — the promoted store with confidence is lossless-claude's own innovation.)
- **Allowlist extraction** — Only extract structured metadata from tool calls. Never store raw tool_response content. Security by construction, not by scrubbing.
- **Sidecar for speed, daemon for smarts** — Hooks write to a fast local SQLite (no daemon dependency). The daemon processes events asynchronously at natural boundaries.
- **Silent fail, never block** — All hook code wraps in try/catch with silent fallback. A failure in passive learning must NEVER block the user's session. This matches context-mode's established pattern (`// PostToolUse must never block the session — silent fallback`). Log errors to `~/.lossless-claude/logs/events.log` for diagnostics, but never surface them to the user.

## Architecture

```
PostToolUse hook ──→ events.db (sidecar, <10ms writes)
UserPromptSubmit ──→ events.db + daemon /prompt-search (existing)
                        │
                        ├── SessionEnd ──→ daemon POST /promote-events
                        ├── Stop ──→ best-effort flush
                        ├── PreCompact ──→ daemon POST /promote-events (with timeout)
                        └── SessionStart ──→ scavenge unprocessed + surface learned insights
                                              │
                                              ▼
                                    promoted table (FTS5/BM25)
                                              │
                                              ▼
                                    prompt-search hints (existing)
```

## 1. Events Sidecar — Schema & Storage

**Location:** `~/.lossless-claude/events/<project-hash>.db`

Uses SHA256(projectDir) hashing, same as the main DB. Worktrees get a suffix derived from the worktree directory name. Each worktree gets its own DB file — `project_id` is derivable from the file path.

```
~/.lossless-claude/events/a1b2c3d4.db                          # main repo
~/.lossless-claude/events/a1b2c3d4-wt-vast-purring-kay.db      # worktree
```

### Shared path resolution

A new `eventsDbPath(cwd)` function (in `src/db/events-path.ts`) computes the sidecar path. Importable from both `src/hooks/` and `src/daemon/routes/` to ensure hooks and daemon always agree on the file location.

### Schema

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version VALUES (1);

CREATE TABLE events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,   -- monotonic counter per session for ordering parallel tool calls
  type          TEXT NOT NULL,                 -- e.g. 'decision', 'file_edit', 'error_tool', 'git_commit'
  category      TEXT NOT NULL,                 -- grouping: 'decision', 'file', 'error', 'git', 'env', 'task', 'intent', 'role', 'mcp', 'subagent', 'skill', 'plan'
  data          TEXT NOT NULL,                 -- extracted content (allowlist, never raw tool output)
  priority      INTEGER DEFAULT 3,             -- 1=high (decisions, errors), 2=medium (git, env), 3=low (file reads)
  source_hook   TEXT NOT NULL,                 -- 'PostToolUse', 'UserPromptSubmit'
  prev_event_id INTEGER,                       -- correlation chain (set during promotion, not capture)
  processed_at  TEXT,                          -- NULL = unprocessed, ISO timestamp = promoted
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX idx_events_session ON events(session_id, created_at);
```

### Design choices

- **WAL mode** enabled for concurrent write safety (multiple sessions, same project).
- **`PRAGMA busy_timeout = 5000`** on every open (matches main DB convention).
- **`seq`** monotonic counter per session — resolves ordering ambiguity for parallel tool calls. Implemented as: `INSERT INTO events (..., seq) VALUES (..., (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?))`. The subquery adds negligible cost since `idx_events_session` covers it. **Race safety:** Within a session, Claude Code processes one tool at a time, so PostToolUse hooks fire sequentially — no concurrent writes for the same session_id. Cross-session writes target different session_ids so the MAX(seq) subquery can't collide. Occasional seq ties are acceptable if they occur — event ordering is best-effort, not a correctness requirement.
- **`prev_event_id`** set during promotion (daemon-side correlation), not during capture (hooks are separate processes with no shared state).
- **`processed_at`** idempotency — if two triggers fire close together, second sees events already processed.
- **No fixed truncation** on `data` — allowlist extraction naturally bounds content. Soft cap at 2000 chars as safety valve.
- **No FTS** on sidecar — it's a capture buffer, not a search target.
- **File permissions** — `0o700` for events directory, `0o600` for DB files.
- **Cleanup** — events with `processed_at` older than 7 days are pruned during SessionStart scavenge.
- **`schema_version`** table for future migrations. `events-db.ts` must include a version-based migration runner: read current version, apply pending migrations in order, update version. Same pattern as `src/db/migration.ts` but simpler (sidecar has one table).

## 2. PostToolUse Hook — Event Extraction

### Hook registration

```json
"PostToolUse": [{
  "matcher": "",
  "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" post-tool" }]
}]
```

### Extraction categories (allowlist)

| Category | Tool Sources | What's Extracted | Priority |
|----------|-------------|-----------------|----------|
| `decision` | AskUserQuestion | Q + A pair (user's answer = decision) | 1 |
| `error` | Bash (exit != 0), any tool with isError | Error type + message, never raw output. We rely on Claude Code's `isError` flag as the authoritative signal — parsing stderr for error patterns would require reading raw output, violating the allowlist principle. | 1 |
| `plan` | EnterPlanMode, ExitPlanMode | Enter/exit + approved/rejected (verify these fire PostToolUse in Claude Code — if not, capture via Write/Edit to `.claude/plans/` path detection) | 1 |
| `git` | Bash (git commands) | Operation type + commit message when present | 2 |
| `task` | TaskCreate, TaskUpdate | Subject + status | 2 |
| `env` | Bash (npm install, pip install, nvm use, etc.) | Command with values scrubbed | 2 |
| `file` | Read, Edit, Write, Glob, Grep | File path + file_class (test/source/config/docs) | 3 |
| `subagent` | Agent | Description + completion status | 3 |
| `skill` | Skill | Skill name | 3 |
| `mcp` | Any mcp__* tool (except lcm_store) | Tool name only, no args | 3 |

### What is NOT captured

- Raw `tool_response` content (never)
- Read/Grep results (only the path/pattern)
- Bash stdout/stderr (only error classification)
- Any tool involving sensitive file paths (`.env`, `.ssh/`, `credentials`, `secrets/`)
- `lcm_store` calls (prevents feedback loops)

### Selective response parsing

Most tools: parse only `tool_name` + `tool_input` from stdin. Exceptions:
- **AskUserQuestion**: parse `tool_response` for the user's answer
- **ExitPlanMode**: parse `tool_response` for approved/rejected
- **Any tool**: check `tool_output.isError` flag (shallow, not the full output string)

### Handler flow

```
post-tool.ts:
  1. Parse stdin (tool_name + tool_input, selective tool_response)
  2. extractors.ts → 0-N events
  3. If 0 events → exit immediately (most calls)
  4. events-db.ts → open sidecar, insert, close
  5. If any priority 1 event → fire daemon POST /promote-events (async, non-blocking via unreffed http.request)
```

### Performance

- **post-tool command bypasses `dispatchHook()` fast path** — `dispatchHook()` currently runs `ensureBootstrapped()` + `validateAndFixHooks()` unconditionally before the command switch. For `post-tool`, add an early return before bootstrap: check command, and if `post-tool`, directly import and call the handler without bootstrap or auto-heal. Bootstrap only runs lazily if a Tier 1 event needs daemon HTTP.
- Node.js cold start is ~100-200ms (same as context-mode's PostToolUse). Our code adds <10ms. Claude Code runs hooks asynchronously.
- Most tool calls produce 0 events → fast exit path.

## 3. Enhanced UserPromptSubmit

### Current behavior
Calls daemon `/prompt-search`, returns hints + static learning instruction.

### Additions

**3a. Decision/intent/role extraction (write to sidecar)**

| Extractor | Pattern Examples | Category | Priority |
|-----------|-----------------|----------|----------|
| Decision | "don't", "never", "always", "use X instead", "prefer" | `decision` | 1 |
| Role | "act as", "senior engineer", "I'm a data scientist" | `role` | 2 |
| Intent | "why/explain/debug" → investigate, "create/fix/build" → implement | `intent` | 3 |

**Negative-match guards:** Decision extractors must exclude false positives from conversational phrases. Examples: "don't worry about tests" should NOT match as a decision about tests. "never mind" should NOT match as a "never" directive. Implementation: maintain a `NEGATIVE_PATTERNS` list (e.g., `don't worry`, `never mind`, `not sure`, `doesn't matter`) checked before positive matching. Test with real-world conversational inputs.

Shared extractors module with PostToolUse (`src/hooks/extractors.ts`).

**3b. Role-aware learning instruction**

If the sidecar has a `role` event for this project, include it in the learning instruction:

```
<learning-instruction>
User context: senior engineer focused on observability
When you recognize a durable insight, call lcm_store immediately:
...
</learning-instruction>
```

### Flow

```
User types prompt
  → hook reads stdin
  → extract decision/role/intent → write to sidecar (<5ms)
  → call daemon /prompt-search → get hints (existing behavior)
  → inject role context into learning instruction (if available)
  → return stdout
```

## 4. Promotion Pipeline

### New daemon route: `POST /promote-events`

Reads sidecar events.db, promotes to promoted table, marks events as processed.

### Three-tier promotion

**Tier 1 — Immediate (priority 1 events):**
- User decisions from AskUserQuestion → promoted with configurable confidence (default 0.5), tag `category:preference`
- Plan approved/rejected → confidence 0.7, tag `category:decision`
- Error→fix pairs (detected by correlation) → confidence 0.4, tag `category:solution`

Promoted during the PostToolUse hook itself (low frequency — AskUserQuestion/plan events happen 2-5 times per session).

**Daemon-down fallback:** If the daemon HTTP call fails (connection refused, timeout), the event is still in the sidecar (already written before the HTTP call). It will be promoted at the next successful trigger (session-end, pre-compact, or next session-start scavenge). No data is lost — only promotion timing is delayed.

**Tier 2 — Batch (priority 2 events):**
- Git operations → aggregate into session summary
- Environment changes → "installed lodash, switched to node 20"
- Task completion patterns

Promoted during session-end/pre-compact as compact summaries. Confidence 0.3.

**Tier 3 — Pattern-only (priority 3 events):**
- File access → only promoted if already in promoted table (bump confidence)
- MCP tool usage → only promoted if distinctive pattern
- Skills/subagents → only promoted if repeatedly used

Check promoted table for existing entries. If found, reinforce via Math.max. If not, mark processed and discard.

### Configurable confidence

Defaults in code, overridable in `~/.lossless-claude/config.json` under the existing `compaction.promotionThresholds` namespace (avoids creating a parallel config tree):

```json
{
  "compaction": {
    "promotionThresholds": {
      "eventConfidence": {
        "decision": 0.5,
        "plan": 0.7,
        "errorFix": 0.4,
        "batch": 0.3,
        "pattern": 0.2
      },
      "reinforcementBoost": 0.3,
      "maxConfidence": 1.0
    }
  }
}
```

> **Note:** These confidence defaults are uncalibrated starting points. They should be tuned based on real-world data after v1 ships. Consider adding a `/lcm-calibrate-events` skill in a future version to help users adjust thresholds based on their promotion quality.

### Confidence reinforcement

When `lcm_store()` is called explicitly and content matches an existing promoted entry (FTS5 similarity), bump confidence by `reinforcementBoost` (capped at `maxConfidence`). Flywheel: passive capture seeds, explicit storage confirms.

### Deduplication

Uses existing `deduplicateAndInsert()` — `listContentPrefixes()` prevents duplicates between DAG promotion (`/promote`) and event promotion (`/promote-events`).

### Auto-tagging

| Event category | Auto-tag |
|---------------|----------|
| decision | `category:preference` |
| error (with fix) | `category:solution` |
| error (no fix) | `category:gotcha` |
| plan | `category:decision` |
| role | `category:user-context` |
| git | `category:workflow` |
| env | `category:environment` |
| file (cross-session) | `category:pattern` |

### Event correlation (daemon-side)

During `/promote-events` batch processing:
1. Sort events by session_id + seq
2. Detect error→success sequences using **command pattern matching** (not just tool_name — Bash errors need the command pattern, e.g., `npm install` → `npm install --legacy-peer-deps`). Match on: tool_name + command prefix (first 2 tokens of Bash commands) + file path (for Edit/Write).
3. Correlate with the **closest preceding error** that matches — not any error in the window. If multiple errors match, pick the one with the highest seq (most recent). This prevents stale errors from incorrectly pairing with unrelated successes.
4. Set `prev_event_id` on the success event → creates error→fix chain
5. Promote the pair as a `category:solution` insight

> **Correlation window:** Only consider events within 20 seq positions of each other in the same session. Beyond that, the error and fix are unlikely to be related.

## 5. Contradiction Detection (v1.1 — Deferred)

> **Deferred to v1.1.** Consensus across 3 independent reviewers: ship capture and promotion first (v1), add contradiction detection once data proves the pipeline works. The sidecar schema and promotion pipeline are designed to support this without schema changes.

When a new promoted entry semantically contradicts an existing one, archive the old entry.

### LLM-based (when provider available)

Uses Haiku — ~100 tokens total, <500ms per check. Only fires when BM25 finds a match above the contradiction threshold during promotion.

**Config:** `contradictionBm25Threshold` (default: 20, intentionally higher than dedup's 15 to reduce false positives).

```
Entry A: "prefer SQLite over Postgres for this project"
Entry B: "migrate to Postgres for better concurrent write support"

Are these contradictory decisions about the same topic? Reply YES or NO.
```

### Fallback (when provider disabled)

Same-topic replacement: if two entries match above a high BM25 threshold AND share the same auto-tag, the newer one supersedes the older.

### Guard rail

Only passively captured events can supersede each other. Explicit `lcm_store()` calls always reinforce (Math.max), never supersede. The user explicitly storing something is a stronger signal than regex extraction.

### v1 behavior (until contradiction detection ships)

Dedup handles near-duplicates via existing `deduplicateAndInsert()`. True contradictions (same topic, opposite decisions) will coexist in the promoted store — both visible in search results. This is acceptable for v1: the lossless philosophy means keeping both is safer than incorrectly archiving one without LLM verification.

## 6. No Confidence Decay

Per lossless-claude's design principle (inspired by Voltropy's lossless philosophy) and the intentional removal of `confidenceDecayRate` from lossless-claw:

| Signal | What it measures | When applied | Mutates storage? |
|--------|-----------------|-------------|-----------------|
| **Confidence** | Truth/quality | Set at promotion, reinforced by Math.max | Only upward |
| **Recency** | Temporal relevance | Query time via `Math.pow(0.5, ageHours / halfLife)` | No |
| **Contradiction** | Staleness | When new insight contradicts old → archive old | Yes (archive, recoverable) |

Unbounded growth is solved by recency at query time — old low-confidence entries never surface in prompt-search results. They're functionally invisible without being deleted.

See: `.xgh/specs/2026-03-25-confidence-decay-analysis.md` for full research.

## 7. Learned-Insights Feedback on SessionStart

### Enhancement to restore hook

After existing DAG restore, surface recently promoted insights:

```xml
<learned-insights source="passive-capture">
Recent learnings from your previous sessions in this project:
- Prefer integration tests over mocks (captured 2 sessions ago, confidence: 0.8)
- Build breaks when editing tsconfig without running tsc (captured last session, confidence: 0.4)
</learned-insights>
```

### Surfacing criteria

- Top N promoted entries (configurable, default 5) by `confidence * recency_score`
- Only entries with `confidence >= 0.3`
- Only entries from the same project
- Exclude archived entries
- Exclude entries older than 90 days (configurable via `insightsMaxAgeDays`, query-time filter, not deletion — consistent with lossless philosophy)
- Dedup against `/restore` output (don't repeat what's already in DAG context)

### Implementation

Extend existing `/restore` response with an `insights` array — avoids a second HTTP round-trip.

## 8. Recovery — Orphaned Events

| Trigger | Hook | Guaranteed? |
|---------|------|------------|
| Clean exit | SessionEnd → `/promote-events` | Yes |
| Ctrl+C | Stop → best-effort flush | Mostly (SIGINT catchable) |
| Mid-session | PreCompact → `/promote-events` (3s timeout) | Yes |
| Next session | SessionStart → scavenge | Yes (safety net) |
| Hard kill | Nothing fires | Orphaned until next session |

Events are never truly lost — SQLite persistence is immediate. Only promotion timing is variable. The `processed_at` idempotency ensures no double-processing if multiple triggers overlap.

**Cleanup:** During SessionStart scavenge, events with `processed_at` older than 7 days are pruned from the sidecar. Unprocessed events are never pruned regardless of age.

## 9. Security

- **Allowlist extraction model** — only extract structured metadata, never raw tool_response content
- **Scrubbing at capture time** — reuse existing `src/scrub.ts` module (comprehensive redaction for API keys, tokens, passwords, etc.) rather than creating a new shared module
- **Sensitive file detection** — skip events for `.env`, `.ssh/`, `credentials`, `secrets/` paths
- **File permissions** — `0o700` for events directory, DB created with appropriate umask
- **No fixed truncation** — allowlist naturally bounds content; soft cap at 2000 chars as safety valve

## 10. File Changes

### New files

| File | Purpose |
|------|---------|
| `src/hooks/post-tool.ts` | PostToolUse handler |
| `src/hooks/events-db.ts` | Sidecar SQLite wrapper (open, migrate, insert, query, close) |
| `src/hooks/extractors.ts` | Event extraction functions (shared by PostToolUse + UserPromptSubmit) |
| ~~`src/shared/scrub.ts`~~ | **Not needed** — reuse existing `src/scrub.ts` which already has comprehensive redaction patterns (API keys, tokens, passwords, Slack tokens, etc.) |
| `src/db/events-path.ts` | Shared `eventsDbPath(cwd)` function for sidecar path resolution |
| `src/daemon/routes/promote-events.ts` | New daemon route for event promotion |

### Modified files

| File | Change |
|------|--------|
| `.claude-plugin/plugin.json` | Add PostToolUse hook entry |
| `src/hooks/dispatch.ts` | Add `post-tool` command (skip bootstrap for sidecar-only path) |
| `src/hooks/user-prompt.ts` | Add decision/intent/role extraction before prompt-search |
| `src/hooks/restore.ts` | Add learned-insights injection |
| `src/hooks/compact.ts` | Add event promotion trigger (with 3s timeout) |
| `src/hooks/session-end.ts` | Add event promotion trigger |
| `src/hooks/session-snapshot.ts` | Add best-effort event flush on Stop |
| `src/hooks/auto-heal.ts` | Add PostToolUse to hook allowlist |
| `src/daemon/server.ts` | Register `/promote-events` route |
| `src/daemon/config.ts` | Add `promotion` config section |

## 11. v1.1 — Deferred Features

### Contradiction Detection

Full implementation of Section 5 — Haiku LLM-based contradiction detection with BM25 fallback. Requires v1 data to validate that the pipeline produces meaningful promoted entries worth running contradiction checks against.

### PreToolUse Proactive Warnings

**Schema-ready in v1.** The events sidecar and promoted store support PreToolUse queries. Auto-tagging makes entries searchable by category.

**Ships in v1.1:** Hook registration, handler (`src/hooks/pre-tool.ts`), daemon route (`POST /tool-warnings`).

**Why defer:** No captured data exists yet. PreToolUse needs a populated promoted store to generate useful warnings. Ship capture first (v1), build query side once data proves valuable.

**Example:**
```
User asks to edit tsconfig.json
→ PreToolUse fires for Edit tool
→ daemon searches promoted: "tsconfig" + category:gotcha
→ finds: "Build breaks when editing tsconfig without running tsc afterward"
→ returns: <tool-warning>Previous sessions suggest: run tsc after editing tsconfig.</tool-warning>
```

## 12. Observability

Basic logging for diagnosing issues without adding infrastructure:

- **Hook-side:** On error, append one-line JSON to `~/.lossless-claude/logs/events.log` (same pattern as `auto-heal.ts`). Include: timestamp, hook name, error message, session_id.
- **Daemon-side:** `/promote-events` logs: events read, events promoted, events skipped (with reason), dedup hits. Uses existing daemon log infrastructure (`config.daemon.logLevel`).
- **`/lcm-doctor` integration:** Extend the existing doctor skill to check: sidecar DB exists, unprocessed event count, last promotion timestamp, events.log error count in last 24h.
- **No metrics/telemetry** — just structured logs. `/lcm-stats` can be extended to show event capture rates.

## Testing

- Unit tests for `extractors.ts` (each extractor function, edge cases, sensitive file detection, **negative-match guards** — verify "don't worry", "never mind", etc. do NOT produce decision events)
- Unit tests for `events-db.ts` (open, migrate, insert, query, concurrent writes, WAL mode)
- Integration tests for `post-tool.ts` (stdin parsing, sidecar writes, Tier 1 daemon HTTP)
- Integration tests for `/promote-events` route (3-tier promotion, dedup, contradiction detection)
- Integration tests for enhanced `user-prompt.ts` (extraction + prompt-search combined flow)
- Integration tests for `restore.ts` (learned-insights injection)
- ~~Dedicated tests for contradiction detection~~ (v1.1 — deferred with contradiction detection)
- E2E test: full cycle from PostToolUse capture → session-end promotion → next session restore with insights

## Non-Goals

- Replacing context-mode's intra-session continuity (SessionDB, session_knowledge directive)
- Cross-project analytics (v2)
- Event sampling for high-volume monorepos (v2)
- Event replay/debugging CLI (v2)
- Embedding-based semantic search on events (v2)
