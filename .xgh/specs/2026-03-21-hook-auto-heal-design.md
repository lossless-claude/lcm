# Hook Auto-Heal & Upgrade Skill

**Date:** 2026-03-21
**Status:** Approved (rev 4 — final)

## Problem

Only 2 of 4 hooks (PreCompact, SessionStart) are registered in `~/.claude/settings.json`. SessionEnd and UserPromptSubmit are declared in `plugin.json` but never make it into settings.json because:

1. `mergeClaudeSettings()` in `installer/install.ts` only registers PreCompact + SessionStart
2. The doctor only validates those same 2 hooks
3. No auto-repair mechanism exists for partial hook clobbering (xgh #17 shallow merge, plugin reinstalls)

**Impact:** Conversations that end without hitting context window compaction never get ingested. Only 2 conversations captured out of many sessions.

## Design

### 1. REQUIRED_HOOKS constant + mergeClaudeSettings fix

**File:** `installer/install.ts`

Export a `REQUIRED_HOOKS` array as the single source of truth:

```ts
export const REQUIRED_HOOKS: { event: string; command: string }[] = [
  { event: "PreCompact", command: "lossless-claude compact" },
  { event: "SessionStart", command: "lossless-claude restore" },
  { event: "SessionEnd", command: "lossless-claude session-end" },
  { event: "UserPromptSubmit", command: "lossless-claude user-prompt" },
];
```

Refactor `mergeClaudeSettings()` to iterate `REQUIRED_HOOKS` instead of hardcoding each event. Same `hasHookCommand()` + `makeHookEntry()` pattern, just data-driven.

### 2. Auto-heal from every hook entry point

**Finding addressed:** If SessionStart itself is clobbered, `restore.ts` never runs, so auto-heal from SessionStart alone doesn't cover the full clobbering failure mode.

**Solution:** Extract `validateAndFixHooks()` into a shared module (`src/hooks/auto-heal.ts`) and call it from **every** CLI hook entry point — compact, restore, session-end, user-prompt. Whichever hook fires first heals the rest.

**Scope of auto-heal:** This covers partial hook loss (1-3 hooks clobbered while at least 1 survives). Total hook loss (all 4 removed from settings.json) cannot be auto-healed from hooks alone — that requires the user to run `/lossless-claude:upgrade` or `lossless-claude install`. The upgrade skill and doctor are the recovery paths for total loss.

**File:** `src/hooks/auto-heal.ts` (new)

```ts
export function validateAndFixHooks(): void
```

1. Read `~/.claude/settings.json`
2. For each entry in `REQUIRED_HOOKS`, check if the command is present
3. If all present, return immediately (fast path — no write, no parse overhead beyond JSON.parse)
4. If any missing, call `mergeClaudeSettings()` and write back
5. Wrap in try/catch — log errors to `~/.lossless-claude/auto-heal.log`, never throw

**File:** `bin/lossless-claude.ts`

Extract hook dispatch into a testable function:

```ts
export const HOOK_COMMANDS = ["compact", "restore", "session-end", "user-prompt"] as const;

export async function dispatchHook(command: string, stdinText: string): Promise<{ exitCode: number; stdout: string }>
```

`dispatchHook()` calls `validateAndFixHooks()` first, then delegates to the appropriate handler. The `main()` switch cases for hook commands call `dispatchHook()`. This makes the auto-heal wiring testable without subprocess spawning.

### 3. Regression tests

**File:** `test/installer/install.test.ts`

- `"registers all 4 required hooks on empty settings"` — asserts `mergeClaudeSettings({})` produces entries for all 4 events
- `"REQUIRED_HOOKS contains exactly the expected events"` — guards against accidental removal
- Update existing test at line 34-39 to check all 4 hooks

**File:** `test/hooks/auto-heal.test.ts` (new)

- `"fixes missing hooks in settings.json"` — mock fs, verify write adds missing entries
- `"no-ops when all hooks present"` — verify no write when healthy
- `"does not throw on fs errors"` — verify swallows errors gracefully
- `"logs errors to auto-heal.log"` — verify error logging path

**File:** `test/installer/uninstall.test.ts`

- `"removes all 4 hook events"` — assert `removeClaudeSettings()` strips all REQUIRED_HOOKS commands

**File:** `test/bin/dispatch-hook.test.ts` (new)

- `"dispatchHook calls validateAndFixHooks before handler"` — mock `validateAndFixHooks` and the handler, verify call order
- `"all HOOK_COMMANDS are recognized"` — verify `dispatchHook` doesn't throw for each value in `HOOK_COMMANDS`
- `"HOOK_COMMANDS matches REQUIRED_HOOKS"` — assert every REQUIRED_HOOKS event has a corresponding HOOK_COMMANDS entry

**File:** `test/doctor/doctor.test.ts` (or inline in existing)

- `"validates all 4 hooks and auto-fixes missing ones"` — verify doctor checks loop covers REQUIRED_HOOKS

### 4. Doctor update

**File:** `src/doctor/doctor.ts`

- Import `REQUIRED_HOOKS` from installer
- Replace hardcoded PreCompact/SessionStart checks (lines 165-183) with a loop over `REQUIRED_HOOKS`
- Display all 4 hook statuses in doctor output (e.g., `PreCompact ✓  SessionStart ✓  SessionEnd ✓  UserPromptSubmit ✓`)
- Auto-fix still calls `mergeClaudeSettings()` (which now handles all 4)

### 5. Upgrade skill

**File:** `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md`

Skill definition (modeled after context-mode's ctx-upgrade):

1. Derive **repo root** from skill base directory — go up **3 levels** (remove `/skills/lossless-claude-upgrade` → `.claude-plugin/` → repo root). The skill lives at `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md`, so up 2 would land in `.claude-plugin/`, not the repo root where `package.json` lives.
2. Run: `cd <REPO_ROOT> && npm run build && npm link`
3. Kill stale daemon: read `~/.lossless-claude/daemon.pid`, kill process
4. Start fresh daemon: `lossless-claude daemon start --detach`
5. Run doctor: `lossless-claude doctor`
6. Display checklist with results
7. Tell user to restart Claude Code session

### 6. Uninstall path

**File:** `installer/uninstall.ts`

Import `REQUIRED_HOOKS` from installer and derive `LC_COMMANDS` set from it instead of hardcoding. Line 11's `new Set(["lossless-claude compact", "lossless-claude restore"])` becomes `new Set(REQUIRED_HOOKS.map(h => h.command))`. Ensures clean uninstall with no orphan entries.

### 7. Release

Follow `RELEASING.md` process. **No manual `npm publish` — use the workflow.**

**Pre-existing state:** `package.json` is already at 0.5.0. There is a pending **minor** changeset at `.changeset/cross-project-improvements.md`. Changesets treats the current version as the base, so `npx changeset status` reports next version as **0.6.0** (0.5.0 + minor).

**Option A (recommended): Fold fix into existing changeset, ship as 0.6.0**

1. Append this fix's description to `.changeset/cross-project-improvements.md` under a new "Fixes" bullet
2. Let Version Packages workflow open the 0.6.0 release PR
3. Merge release PR → trigger Publish Package

This is simplest — one release covers both the unreleased 0.5.0 features and this hook fix.

**Option B: Ship fix independently as patch**

1. Delete the existing minor changeset (defer those features)
2. Add a patch changeset for this fix only → 0.5.1
3. Re-add the minor changeset later for the next release

Option A avoids version gymnastics and gets everything published in one shot.

### 8. README update

**File:** `README.md`

Update hook documentation (currently only lists PreCompact and SessionStart at lines ~75 and ~141) to show all 4 hooks and their commands.

## Files Changed

| File | Change |
|------|--------|
| `installer/install.ts` | Add REQUIRED_HOOKS, refactor mergeClaudeSettings() |
| `installer/uninstall.ts` | Use REQUIRED_HOOKS for cleanup |
| `src/hooks/auto-heal.ts` | New — shared validateAndFixHooks() |
| `src/doctor/doctor.ts` | Import REQUIRED_HOOKS, validate all 4 hooks |
| `bin/lossless-claude.ts` | Extract dispatchHook(), call validateAndFixHooks() |
| `test/installer/install.test.ts` | Regression tests for all 4 hooks |
| `test/installer/uninstall.test.ts` | Test removal of all 4 hooks |
| `test/hooks/auto-heal.test.ts` | New — auto-heal unit tests |
| `test/bin/dispatch-hook.test.ts` | New — dispatcher wiring tests |
| `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md` | New upgrade skill |
| `README.md` | Document all 4 hooks |
| `.changeset/*.md` | Changeset for release |

## Non-goals

- Changing the plugin.json manifest (already correct with all 4 hooks)
- Modifying the daemon version reporting (fixed by daemon restart)
- Backfilling missed conversations from past sessions (no transcript data available)
