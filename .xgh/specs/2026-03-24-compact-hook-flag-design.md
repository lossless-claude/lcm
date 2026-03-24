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
batchMode = all || stdin.isTTY || dryRun || verbose || replay || noPromote || !hook
hookMode  = hook (explicit --hook flag only)
```

In practice: if `--hook` is not passed, batch mode runs. The `stdin.isTTY` check is now redundant but kept as a safety net for clarity.

The `--hook` flag is **not shown in `lcm compact --help`** — it is an internal flag for the Claude Code hook integration.

### 2. `installer/install.ts` — hook registration

```diff
- { event: "PreCompact", command: "lcm compact" }
+ { event: "PreCompact", command: "lcm compact --hook" }
```

### 3. `src/hooks/auto-heal.ts` — rewrite rule for existing installs

`validateAndFixHooks` gains a rewrite rule:

- Detect: hook entry with `command` matching `lcm compact` (exact, no `--hook`)
- Rewrite: `lcm compact` → `lcm compact --hook`

This fires on the first hook invocation after the user updates lcm, requiring no manual intervention.

## Tests

| Area | What to test |
|------|-------------|
| `bin/lcm.ts` routing | Zero-flag non-TTY → batch mode (not hook dispatch) |
| `bin/lcm.ts` routing | `--hook` flag → hook dispatch path |
| `auto-heal.ts` | `lcm compact` entry in settings.json is rewritten to `lcm compact --hook` |
| `installer/install.ts` | Registered PreCompact command is `lcm compact --hook` |

## Migration

Existing users: auto-healed on first hook invocation (no action required).
New installs: correct from the start.

## Non-Goals

- No changes to `lcm import`, `lcm promote`, or other commands
- No changes to what batch compact does
- No changes to the hook payload format or daemon interaction
