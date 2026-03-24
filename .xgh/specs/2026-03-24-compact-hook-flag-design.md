---
**Date:** 2026-03-24
**Issue:** #90 (lcm compact hangs indefinitely in non-TTY without flags)
**Status:** Approved
---

# lcm compact `--hook` Flag — Design Spec

## Problem

`lcm compact` (zero flags, non-TTY stdin) hangs forever. The command routes to hook dispatch mode, which calls `readStdin()` before doing anything. In a bash `&&` chain or any script context, stdin is inherited from the shell and never closed, so the process blocks indefinitely.

Root cause: the TTY check (`process.stdin.isTTY`) was the only signal distinguishing "called interactively" from "called from a hook." That's the wrong signal — a script is not a hook.

## Solution

Make hook dispatch opt-in via an explicit `--hook` flag. Zero-flag invocations always enter batch mode regardless of TTY state.

## Changes

### 1. `bin/lcm.ts` — compact command routing

Add `--hook` option (hidden from help). Routing becomes:

```
if (hook)  → hook dispatch (reads stdin)
else       → batch mode  ← zero-flag non-TTY lands here now
```

The existing `batchMode` expression (`all || stdin.isTTY || dryRun || verbose || replay`) is replaced by simply: "if `--hook` is not set, run batch mode." The `stdin.isTTY` check becomes unnecessary but can be removed — the `--hook` flag is now the only gating condition for the hook path.

The `--hook` flag is **not shown in `lcm compact --help`** — it is an internal flag for Claude Code hook integration.

### 2. Hook registration — two authoritative sources

**`installer/install.ts`** (direct/npm installs — writes to `settings.json`):
```diff
- { event: "PreCompact", command: "lcm compact" }
+ { event: "PreCompact", command: "lcm compact --hook" }
```

**`.claude-plugin/plugin.json`** (plugin installs — Claude Code reads this directly):
```diff
- "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" compact"
+ "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" compact --hook"
```

Both files must be updated. `plugin.json` is authoritative for plugin-based installs; `install.ts` for direct installs.

### 3. `src/hooks/auto-heal.ts` — rewrite rule for existing direct installs

`validateAndFixHooks` gains a rewrite rule:

- Detect: hook entry where `command` starts with `"lcm compact"` but does not include `"--hook"`
- Rewrite: append `" --hook"` to the command

Using `startsWith` rather than exact match handles users who may have added flags like `--all` or `--dry-run` to their hook entry.

**Known limitation:** auto-heal fires on hook invocation (when Claude triggers PreCompact), not on `lcm install` or daemon startup. A user who runs `lcm compact` in a script before any Claude session fires PreCompact will still hit the hang until auto-heal has run. Mitigation: the `lcm install` command can call `validateAndFixHooks` explicitly, which is already the expected flow for updates.

Plugin-based installs do not need auto-heal — `plugin.json` is updated as part of the package and takes effect immediately.

## Tests

| Area | Case | Expected |
|------|------|----------|
| `bin/lcm.ts` routing | Zero flags, non-TTY stdin | Batch mode (not hook dispatch) |
| `bin/lcm.ts` routing | `--hook` flag, non-TTY stdin | Hook dispatch (reads stdin) |
| `bin/lcm.ts` routing | `--hook` flag, TTY stdin | Hook dispatch (TTY does not override `--hook`) |
| `auto-heal.ts` | `settings.json` has `lcm compact` | Rewritten to `lcm compact --hook` |
| `auto-heal.ts` | `settings.json` has `lcm compact --all` | Rewritten to `lcm compact --all --hook` |
| `installer/install.ts` | PreCompact REQUIRED_HOOKS entry | Command is `lcm compact --hook` |

## Migration

| Install type | How migrated |
|---|---|
| Plugin install | `plugin.json` updated in package — takes effect on next Claude Code session |
| Direct install (new) | `installer/install.ts` change — correct from the start |
| Direct install (existing) | `auto-heal.ts` rewrite rule — fires on first PreCompact hook invocation |

## Non-Goals

- No changes to `lcm import`, `lcm promote`, or other commands
- No changes to what batch compact does
- No changes to the hook payload format or daemon interaction
