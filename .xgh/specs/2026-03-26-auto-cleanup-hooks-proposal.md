# Proposal: Auto-Cleanup Stale Hooks on Startup

## Status: Investigation Complete — No Action Needed ✓

This idea was explored but **already implemented**.

---

## Problem Statement
Users upgrading from old binary-based install (hooks in `~/.claude/settings.json`) to plugin-based system (hooks in `plugin.json`) end up with duplicate `SessionStart` hooks firing. The diagnose tool catches it but doesn't prevent it.

## Proposed Solution (Original Idea)
When `lcm.mjs` runs ANY command, check `~/.claude/settings.json` for stale `lossless-claude restore` entries and silently remove them.

## Current Implementation

**The cleanup already exists and is comprehensive:**

### 1. **`mergeClaudeSettings()` — Core Migration Logic**
   - **Location:** `src/installer/settings.ts`
   - **Behavior:**
     - Migrates old commands: `"lossless-claude restore"` → `"lcm restore"`
     - Removes ALL `REQUIRED_HOOKS` from `settings.json` (SessionStart, PreCompact, PostToolUse, etc.)
     - Deduplicates hooks after migration
     - Removes legacy MCP entry `mcpServers["lossless-claude"]`
   - **Returns:** Cleaned settings object (doesn't write unless explicitly called)

### 2. **`ensureCore()` — Runs on Bootstrap**
   - **Location:** `src/bootstrap.ts`
   - **When:** Every session via `ensureBootstrapped()` on daemon startup
   - **Behavior:**
     - Parses existing `settings.json`
     - Calls `mergeClaudeSettings()`
     - Only rewrites file if data changed (atomic check)
     - Silently fails if `settings.json` doesn't exist or is invalid

### 3. **`validateAndFixHooks()` — Runs on Hook Execution**
   - **Location:** `src/hooks/auto-heal.ts`
   - **When:** Called at start of every hook command via `src/hooks/dispatch.ts`
   - **Behavior:**
     - Detects duplicate hooks + legacy `"lcm compact"` command
     - Applies `mergeClaudeSettings()` and rewrites `settings.json`
     - Logs errors to `~/.lossless-claude/auto-heal.log` (never crashes)

### 4. **Doctor also Detects & Fixes**
   - **Location:** `src/doctor/doctor.ts:300-327`
   - **Behavior:** Runs `mergeClaudeSettings()` and reports result

## Conclusion

**The proposed solution is already in place:**

✓ Runs on every session (via `ensureCore()`)  
✓ Runs on every hook execution (via `validateAndFixHooks()`)  
✓ Migrates old hook commands to new format  
✓ Removes ALL required hooks from `settings.json` (prevents double-firing)  
✓ Atomic file writes (only if data changed)  
✓ Silent failures (never blocks hook execution)  
✓ Comprehensive logging for troubleshooting  

**No additional implementation needed.** If users still see duplicates, it's likely:
1. Manual edits to `settings.json` after cleanup runs
2. Timing issue (hook entry cache not refreshed yet)
3. Bug in `mergeClaudeSettings()` logic (edge case)

## Recommendations

1. **If duplicate hooks still occur in the wild:** Investigate if `mergeClaudeSettings()` has edge cases (e.g., non-standard hook structure from old installer versions)
2. **For transparency:** Document the auto-cleanup in user-facing docs
3. **For robustness:** Consider adding telemetry to `ensureCore()` and `validateAndFixHooks()` to track cleanup frequency
