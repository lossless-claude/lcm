---
name: lcm-e2e
description: Run the E2E validation checklist against a real lcm installation. Tests daemon, hooks, import, compact, promote, retrieval, and resilience. Pass a flow name for a subset (import, compact, promote, curate, retrieval, hooks, doctor, cleanup), or omit for the full suite.
allowed-tools: Bash, Read
user-invocable: true
---

## Current state

### lcm binary
!`lcm --version 2>/dev/null || echo "ERROR: lcm not in PATH"`

### Daemon status
!`lcm status 2>/dev/null || echo "Daemon not running"`

## Task

Run the E2E validation checklist from `.claude-plugin/skills/lcm-e2e/checklist.md`.

**Arguments:** `$ARGUMENTS`

- If `$ARGUMENTS` is empty → run all flows in order
- If `$ARGUMENTS` is `import` → run Flows 1, 2, 3, 4
- If `$ARGUMENTS` is `compact` → run Flows 1, 2, 5
- If `$ARGUMENTS` is `promote` → run Flows 1, 2, 5, 6
- If `$ARGUMENTS` is `curate` → run Flows 1, 2, 5, 6, 7
- If `$ARGUMENTS` is `retrieval` → run Flows 1, 2, 5, 6, 8
- If `$ARGUMENTS` is `hooks` → run Flows 1, 2, 9, 10, 14, 15, 16, 18
- If `$ARGUMENTS` is `doctor` → run Flows 1, 11, 12, 19
- If `$ARGUMENTS` is `cleanup` → run Flow 13 only

## Steps

1. Read the checklist: `.claude-plugin/skills/lcm-e2e/checklist.md`
2. Determine which flows to run based on arguments
3. For each step in each flow:
   a. Print the step description
   b. Run the command
   c. Evaluate against expected output
   d. Mark ✓ (pass) or ✗ (fail) with a one-line explanation
4. If a flow fails a critical step, note it and continue (don't abort)
5. Always run Flow 13 (cleanup) at the end of the full suite
6. Print the summary table with actual ✓/✗ results

## CRITICAL: Data Isolation

**Live mode NEVER touches user data.**

All operations use an isolated temp directory as `cwd`:
- Create: `mktemp -d /tmp/lcm-e2e-test-XXXXXX`
- This temp cwd creates a separate project database under `~/.lossless-claude/projects/<hash>/`
- The user's real project data is never accessed
- Cleanup removes both the temp dir AND the project under `~/.lossless-claude/projects/`

## Important notes

- This modifies ONLY temp/test directories — never the user's real project
- Auto-heal flow (16) is READ-ONLY in live mode: verify hooks exist, don't break them
- If lcm is not in PATH, show an error and stop
- If daemon is not running, try `lcm daemon start --detach` first
- Do not abort on first failure — the goal is a complete picture
