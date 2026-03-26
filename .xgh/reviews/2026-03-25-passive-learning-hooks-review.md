# Architecture Review: Passive Learning Hooks Design Spec

**Reviewer:** Senior System Architect
**Date:** 2026-03-25
**Spec:** `.xgh/specs/2026-03-25-passive-learning-hooks-design.md`
**Supporting:** `.xgh/specs/2026-03-25-confidence-decay-analysis.md`
**Verdict:** Approve with required changes (2 blockers, 4 major, 5 minor)

---

## What Was Done Well

- **Sidecar/daemon split is sound.** The <10ms sidecar write path that avoids daemon dependency is the right call for a PostToolUse hook that fires on every tool call. The existing hooks (compact, restore, session-end) all block on daemon HTTP — that pattern cannot scale to PostToolUse frequency.
- **No confidence decay.** The analysis doc is rigorous. The three-signal model (confidence for quality, recency at query time, contradiction for staleness) is well-reasoned and consistent with the codebase's existing `Math.max` reinforcement in `src/promotion/dedup.ts`.
- **Allowlist extraction model.** Never storing raw `tool_response` content is the correct security posture. The explicit exceptions (AskUserQuestion answer, ExitPlanMode status, isError flag) are justified and minimal.
- **Recovery model.** The four-trigger promotion (SessionEnd, Stop, PreCompact, SessionStart scavenge) with `processed_at` idempotency is production-grade. Events survive every failure mode except hard kill, and even then they're recovered next session.
- **Deferred PreToolUse.** Correct decision to ship capture before query. No data = no useful warnings.

---

## Blockers (must fix before implementation)

### B1. PostToolUse hook uses wrong invocation pattern — plugin.json vs. `dispatch.ts` mismatch

**Severity:** Blocker
**Files:** `src/hooks/dispatch.ts`, `.claude-plugin/plugin.json`, `bin/lcm.ts`

The spec registers PostToolUse in `plugin.json` as:
```json
"PostToolUse": [{ "hooks": [{ "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" post-tool" }] }]
```

But every existing hook in `plugin.json` invokes `node ... lcm.mjs <command>`, and `bin/lcm.ts` routes those commands through Commander.js subcommands. The `post-tool` command does not exist in `bin/lcm.ts`, and `HOOK_COMMANDS` in `dispatch.ts` does not include it.

The spec says to "add an early return before bootstrap" in `dispatchHook()`, but the actual CLI entrypoint (`bin/lcm.ts`) does NOT go through `dispatchHook()` for every hook — each subcommand independently imports `dispatchHook` and calls it with a hardcoded command string. There is no single dispatch function that runs `ensureBootstrapped()` first and then switches — it's `dispatchHook()` itself that does both.

**The spec's performance optimization (skip bootstrap for `post-tool`) is correct in intent but wrong in mechanism.** The implementation needs to:
1. Add a `post-tool` subcommand to `bin/lcm.ts`
2. Add `"post-tool"` to `HOOK_COMMANDS` in `dispatch.ts`
3. Add the early-return in `dispatchHook()` BEFORE the `ensureBootstrapped()` call (which the spec says, but the current code structure means bootstrap + validateAndFixHooks run unconditionally before the switch — the early return must go before line 16)

**Or, alternatively:** The `post-tool` subcommand in `bin/lcm.ts` can bypass `dispatchHook()` entirely and directly import `handlePostTool` — matching the pattern but skipping bootstrap. This is cleaner. The spec should be explicit about which path it takes.

**Fix:** Add a new section or update Section 2 to include the `bin/lcm.ts` subcommand registration. Decide explicitly: does `post-tool` go through `dispatchHook()` with an early return, or bypass it entirely from `bin/lcm.ts`? The bypass approach is simpler and safer.

### B2. `src/shared/scrub.ts` conflicts with existing `src/scrub.ts`

**Severity:** Blocker
**Files:** `src/scrub.ts` (existing), `src/shared/scrub.ts` (proposed)

The spec proposes `src/shared/scrub.ts` as "Shared redaction patterns (importable by both hooks and daemon, single source of truth)." But `src/scrub.ts` already exists with comprehensive patterns (`BUILT_IN_PATTERNS`) and is already imported by daemon routes (ingest, compact, store) and `src/summarize.ts`.

Creating a parallel `src/shared/scrub.ts` introduces two sources of truth for redaction — the opposite of the stated goal. The existing `src/scrub.ts` is already importable from hooks (it has no daemon-specific dependencies — it imports only `node:fs/promises` and `node:path`).

**Fix:** Remove `src/shared/scrub.ts` from the file changes table. Import `src/scrub.ts` directly from hook handlers. If any hook-specific redaction logic is needed (e.g., sensitive file path detection), add it as a new export in `src/scrub.ts` or create `src/hooks/sensitive-paths.ts` for that narrow concern.

---

## Major Issues (should fix)

### M1. Config sprawl — new `promotion` section overlaps existing `compaction.promotionThresholds`

**Severity:** Major
**File:** `src/daemon/config.ts`

The spec adds a new top-level `promotion` config section:
```json
{ "promotion": { "confidence": { "decision": 0.5, ... }, "reinforcementBoost": 0.3, ... } }
```

But `DaemonConfig` already has `compaction.promotionThresholds` with `dedupBm25Threshold`, `dedupCandidateLimit`, and keyword-based promotion. Now users have two places to configure promotion behavior: `compaction.promotionThresholds` for DAG-based promotion and `promotion.confidence` for event-based promotion.

**Fix:** Nest the new config under `compaction.promotionThresholds.events` or create a clear naming convention that distinguishes DAG promotion from event promotion. At minimum, add a comment in the spec explaining the relationship and why they're separate.

### M2. UserPromptSubmit regex extraction of "decisions" is fragile and creates noise

**Severity:** Major
**File:** `src/hooks/user-prompt.ts` (modified), `src/hooks/extractors.ts` (new)

Section 3a proposes extracting decisions from user prompts via pattern matching on words like "don't", "never", "always", "prefer". Consider these common prompts:
- "don't worry about tests for now" -> extracted as a `decision` at priority 1
- "I always forget the syntax for..." -> extracted as a `decision` at priority 1
- "never mind, let's do something else" -> extracted as a `decision` at priority 1

These false positives will pollute the promoted store with noise at the highest priority level. The spec provides no filtering mechanism beyond the keyword match.

**Fix:** Either (a) lower priority of prompt-extracted decisions to 2, not 1, since they lack the structured context of AskUserQuestion responses, or (b) require compound patterns (e.g., "always use X", "never do Y", "prefer X over Y") that are more likely to be actual preferences, or (c) defer prompt decision extraction to v1.1 and only capture role/intent in v1 (which are lower risk).

### M3. Contradiction detection via Haiku LLM adds a hard dependency on provider config

**Severity:** Major
**Files:** `src/daemon/config.ts`, proposed `src/daemon/routes/promote-events.ts`

Section 5 says contradiction detection "Uses Haiku — ~100 tokens total." But the current `llm.provider` config can be `"disabled"`, `"auto"`, `"claude-process"`, etc. The spec mentions a fallback (same-topic BM25 replacement) but doesn't specify:
- Which provider setting triggers Haiku vs. fallback?
- What happens when `provider: "auto"` but no Claude process is running (e.g., in a cron-triggered promote)?
- Is the Haiku call synchronous within the `/promote-events` route? If so, it blocks batch promotion.

**Fix:** Add a decision table: `provider=disabled -> BM25 fallback only`, `provider=anthropic -> Haiku API call`, `provider=auto/claude-process -> BM25 fallback` (since process providers are ephemeral). Make it explicit that contradiction detection never blocks event promotion — it should be best-effort.

### M4. Event correlation (error->fix detection) is underspecified

**Severity:** Major
**File:** Proposed `src/daemon/routes/promote-events.ts`

Section 4 says: "Detect error->success sequences (same tool_name, error at T1, success at T2)." This is too simplistic:
- Same tool_name is not sufficient — `Bash` is used for hundreds of different commands. An error on `npm install` followed by a successful `git push` would match.
- The spec says `prev_event_id` creates an error->fix chain, but `data` only stores "Error type + message" for errors. What's stored for the "fix" event? Just "Bash succeeded"? That's not useful as a `category:solution` insight.
- No maximum distance specified — how many events apart can an error and fix be?

**Fix:** Tighten the correlation: require same tool_name AND same or overlapping `data` content (e.g., same npm package, same file path). Add a maximum distance (e.g., 5 events). For Bash specifically, match on the command prefix (e.g., `npm install`), not just `tool_name: "Bash"`. Specify what the promoted `category:solution` content actually looks like — "Error: X. Fix: ran Y" needs a concrete template.

---

## Minor Issues (nice to have)

### m1. `seq` subquery may cause contention under concurrent writes

**Severity:** Minor
**File:** Proposed `src/hooks/events-db.ts`

The spec uses `SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?` inside an INSERT. With WAL mode and concurrent sessions writing to the same sidecar, this could produce duplicate `seq` values if two inserts for the same session_id race. This is unlikely in practice (one session = one Claude process = sequential tool calls), but worth noting.

**Fix:** Document that `seq` is best-effort ordering, not a uniqueness constraint. Or add `UNIQUE(session_id, seq)` with `ON CONFLICT REPLACE` if strict ordering matters.

### m2. Learned-insights in SessionStart adds latency to session startup

**Severity:** Minor
**File:** `src/hooks/restore.ts` (modified)

Section 7 extends `/restore` to include insights. The current `handleSessionStart` makes one HTTP call to `/restore`. Adding insights means the daemon must query the promoted table during restore, adding ~5-20ms. This is probably fine, but the spec should note it.

**Fix:** Add a sentence acknowledging the marginal latency. The `/restore` route already queries the DB, so this is an incremental cost, not a new round-trip.

### m3. The `plan` category relies on unverified Claude Code hook behavior

**Severity:** Minor
**File:** Proposed `src/hooks/extractors.ts`

Section 2 notes "(verify these fire PostToolUse in Claude Code)" for EnterPlanMode/ExitPlanMode. If they don't fire PostToolUse, the fallback is "capture via Write/Edit to `.claude/plans/` path detection." This fallback is left as a parenthetical rather than a concrete design.

**Fix:** Verify before implementation. If plan mode tools don't fire PostToolUse, add a concrete extractor for Write/Edit that checks for `.claude/plans/` in the file path, and document the expected `data` shape.

### m4. 7-day cleanup of processed events should be configurable

**Severity:** Minor
**File:** Proposed `src/hooks/events-db.ts`

The spec hardcodes "events with `processed_at` older than 7 days are pruned." Other timing constants (snapshotIntervalSec, recencyHalfLifeHours) are configurable.

**Fix:** Add `events.retentionDays` to config with default 7.

### m5. `src/db/events-path.ts` duplicates existing path resolution pattern

**Severity:** Minor
**Files:** `src/daemon/project.ts` (existing `projectId`, `projectDbPath`), proposed `src/db/events-path.ts`

The spec creates a new path resolution module but the existing `projectId(cwd)` and `projectDbPath(cwd)` in `src/daemon/project.ts` already handle SHA256 hashing and worktree suffixes. `eventsDbPath` should delegate to `projectId()` and construct the path from its output rather than reimplementing the hash logic.

**Fix:** `eventsDbPath(cwd)` should import `projectId` from `src/daemon/project.ts` and return `~/.lossless-claude/events/${projectId(cwd)}.db`.

---

## Scope Assessment

The spec covers: events sidecar + PostToolUse extraction + enhanced UserPromptSubmit + 3-tier promotion + contradiction detection + learned-insights feedback. That is six interacting subsystems.

**Recommendation:** The scope is manageable IF contradiction detection (Section 5) is deferred to v1.1 alongside PreToolUse. The BM25 fallback alone is insufficient for production (high false positive rate on same-tag matching), and the Haiku path introduces provider complexity. Without contradiction detection, the system still works — old entries just rank lower via recency scoring, which is the existing behavior.

If contradiction detection ships in v1, it should be BM25-only with a very high threshold (30+), no LLM involvement. LLM-based contradiction can ship alongside PreToolUse when the promoted store has enough data to justify the cost.

---

## Migration Path Assessment

**No breaking changes.** The spec is additive:
- New SQLite database (events sidecar) — no schema changes to existing DBs
- New hook (PostToolUse) — existing hooks unchanged
- New daemon route (`/promote-events`) — existing routes unchanged
- New config section (`promotion`) — existing config unaffected via `deepMerge`

Upgrade path: install new version, new hook auto-registers via `plugin.json`, events sidecar created on first PostToolUse fire. Zero user action required.

The only risk is `auto-heal.ts` — it needs to know about the PostToolUse hook to prevent double-firing if it somehow ends up in `settings.json`. The spec correctly lists auto-heal.ts as a modified file.

---

## Summary of Required Actions

| # | Severity | Issue | Action |
|---|----------|-------|--------|
| B1 | Blocker | `post-tool` CLI routing undefined | Specify `bin/lcm.ts` subcommand + decide: bypass or early-return |
| B2 | Blocker | `src/shared/scrub.ts` duplicates `src/scrub.ts` | Use existing `src/scrub.ts`, remove new file |
| M1 | Major | Config sprawl with two promotion sections | Nest under `compaction.promotionThresholds.events` or document split |
| M2 | Major | Regex decision extraction is noisy | Require compound patterns or lower priority |
| M3 | Major | Haiku contradiction dependency underspecified | Add provider decision table, make best-effort |
| M4 | Major | Error->fix correlation too simplistic | Tighten matching, add max distance, define output template |
| m1 | Minor | `seq` race condition | Document as best-effort or add UNIQUE constraint |
| m2 | Minor | Learned-insights adds restore latency | Acknowledge in spec |
| m3 | Minor | Plan mode hook behavior unverified | Verify before implementation, design fallback concretely |
| m4 | Minor | 7-day cleanup hardcoded | Make configurable |
| m5 | Minor | `events-path.ts` duplicates `projectId()` | Delegate to existing function |
