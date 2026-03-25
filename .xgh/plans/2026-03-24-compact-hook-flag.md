# lcm compact --hook Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit `--hook` flag to `lcm compact` so zero-flag non-TTY invocations default to batch mode instead of hanging on stdin.

**Architecture:** Replace the TTY-based `batchMode` guard in `bin/lcm.ts` with an explicit `--hook` option. Update both authoritative hook registration sources (`plugin.json` and `installer/install.ts`) to pass `--hook`. Add a migration rewrite rule in `auto-heal.ts` for existing direct installs.

**Tech Stack:** TypeScript, Commander.js (`Command`, `Option`), Node.js `node:fs`, Vitest

**Spec:** `.xgh/specs/2026-03-24-compact-hook-flag-design.md`
**Issue:** #90

---

## File Map

| File | Change |
|------|--------|
| `bin/lcm.ts` | Add `Option` to commander import; add hidden `--hook` option; replace `batchMode` with `if (!hook)` |
| `installer/install.ts` | `REQUIRED_HOOKS` PreCompact: `"lcm compact"` → `"lcm compact --hook"` |
| `.claude-plugin/plugin.json` | PreCompact command: append ` --hook` |
| `src/hooks/auto-heal.ts` | New rewrite rule before duplicate detection |
| `test/bin/compact-routing.test.ts` | New file — Commander.js option parsing tests |
| `test/hooks/auto-heal.test.ts` | 2 new cases for the rewrite rule |
| `test/installer/install.test.ts` | Update assertions that hardcode `"lcm compact"` |

---

### Task 1: Add `--hook` flag to `bin/lcm.ts`

**Files:**
- Modify: `bin/lcm.ts` (line 3 import, lines 96–206 compact command)

The compact command currently routes with:
```typescript
const batchMode = all || process.stdin.isTTY || dryRun || verbose || replay;
if (batchMode) { /* batch */ } else { /* hook dispatch */ }
```

Replace with an explicit `--hook` option. Zero-flag invocations (including non-TTY) go to batch.

- [ ] **Step 1: Add `Option` to the commander import**

Line 3 of `bin/lcm.ts` currently reads:
```typescript
import { Command } from "commander";
```

Change it to:
```typescript
import { Command, Option } from "commander";
```

- [ ] **Step 2: Add the hidden `--hook` option to the compact command**

In the `.command("compact")` chain, after the `-v, --verbose` option (line 103) and before `.helpOption(false)` (line 104), insert:

```typescript
.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp())
```

The chain becomes:
```typescript
.option("-v, --verbose", "Show per-session token details")
.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp())
.helpOption(false)
```

- [ ] **Step 3: Update routing logic**

Inside the `.action(async (opts) => { ... })`, after the `if (opts.help)` block, replace:

```typescript
const all: boolean = opts.all ?? false;
const dryRun: boolean = opts.dryRun ?? false;
const verbose: boolean = opts.verbose ?? false;
const replay: boolean = opts.replay ?? false;
// Batch mode: --all, TTY stdin, or any explicit flag ...
const batchMode = all || process.stdin.isTTY || dryRun || verbose || replay;
if (batchMode) {
```

With:

```typescript
const all: boolean = opts.all ?? false;
const dryRun: boolean = opts.dryRun ?? false;
const verbose: boolean = opts.verbose ?? false;
const replay: boolean = opts.replay ?? false;
const hook: boolean = opts.hook ?? false;
if (!hook) {
```

The else branch remains unchanged: it reads stdin and dispatches to the hook handler.

- [ ] **Step 4: Verify TypeScript compiles clean**

```bash
cd /Users/pedro/Developer/lossless-claude && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add bin/lcm.ts
git commit -m "feat(cli): add explicit --hook flag to lcm compact

Zero-flag non-TTY invocations now route to batch mode instead of
hook dispatch. Hook dispatch requires --hook. Fixes #90."
```

---

### Task 2: Add routing unit tests for the `--hook` flag

**Files:**
- Create: `test/bin/compact-routing.test.ts`

Test that Commander.js correctly parses the `--hook` option in isolation. This validates all three routing cases from the spec without needing to invoke the full binary.

- [ ] **Step 1: Create the test file**

```typescript
// test/bin/compact-routing.test.ts
import { describe, it, expect } from "vitest";
import { Command, Option } from "commander";

/** Minimal replica of the compact command's option setup. */
function makeCompactCmd() {
  const cmd = new Command("compact");
  cmd.option("--all", "Compact all tracked projects");
  cmd.option("--dry-run");
  cmd.option("--replay");
  cmd.option("-v, --verbose");
  cmd.addOption(new Option("--hook", "Hook dispatch mode (internal)").hideHelp());
  return cmd;
}

describe("compact command --hook routing", () => {
  it("zero flags: opts.hook is falsy → batch mode", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync([], { from: "user" });
    expect(cmd.opts().hook).toBeFalsy();
  });

  it("--hook flag: opts.hook is true → hook dispatch", async () => {
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook with TTY: opts.hook is true → hook dispatch (TTY does not override --hook)", async () => {
    // TTY state is irrelevant when --hook is explicit; parsed opts reflect only flags
    const cmd = makeCompactCmd();
    await cmd.parseAsync(["--hook"], { from: "user" });
    expect(cmd.opts().hook).toBe(true);
  });

  it("--hook is hidden from help output", () => {
    const cmd = makeCompactCmd();
    const helpText = cmd.helpInformation();
    expect(helpText).not.toContain("--hook");
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run test/bin/compact-routing.test.ts 2>&1 | tail -20
```

Expected: all 4 pass.

- [ ] **Step 3: Commit**

```bash
git add test/bin/compact-routing.test.ts
git commit -m "test(cli): add compact --hook routing unit tests

Covers all three routing cases from spec: zero-flags→batch,
--hook→dispatch, --hook+TTY→dispatch. Also verifies flag is hidden."
```

---

### Task 3: Update hook registrations

**Files:**
- Modify: `installer/install.ts:7`
- Modify: `.claude-plugin/plugin.json:24`

Both files are authoritative sources for the PreCompact hook command. Update both to pass `--hook`.

- [ ] **Step 1: Update `installer/install.ts` REQUIRED_HOOKS**

Change line 7:
```typescript
// Before:
{ event: "PreCompact", command: "lcm compact" },
// After:
{ event: "PreCompact", command: "lcm compact --hook" },
```

- [ ] **Step 2: Update `.claude-plugin/plugin.json` PreCompact hook**

Change line 24:
```json
// Before:
"command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" compact"
// After:
"command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" compact --hook"
```

- [ ] **Step 3: Update install.test.ts to reflect new command**

Search for hardcoded `"lcm compact"` (without `--hook`) in the install test:

```bash
grep -n '"lcm compact"' test/installer/install.test.ts
```

Update each occurrence that refers to the PreCompact hook command to `"lcm compact --hook"`. Do NOT change occurrences that test the removal of old-style hooks (if any).

- [ ] **Step 4: Run installer tests**

```bash
npx vitest run test/installer/install.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add installer/install.ts .claude-plugin/plugin.json test/installer/install.test.ts
git commit -m "feat(hooks): register 'lcm compact --hook' in plugin.json and install.ts

Updates both authoritative hook registration sources to use the new
explicit --hook flag. Part of fix for issue #90."
```

---

### Task 4: Add migration rewrite rule to `auto-heal.ts`

**Files:**
- Modify: `src/hooks/auto-heal.ts`
- Modify: `test/hooks/auto-heal.test.ts`

Add a rewrite rule that detects `"lcm compact"` without `--hook` and upgrades it. This runs on the first PreCompact invocation for existing direct installs.

**How the rewrite interacts with existing logic:**

After the rewrite loop mutates `settings.hooks` in-place:
- `"lcm compact"` → rewritten to `"lcm compact --hook"` → `hasDuplicates` fires (REQUIRED_HOOKS now has `"lcm compact --hook"`) → `mergeClaudeSettings` removes it (exact match). Written settings have **no PreCompact entry**.
- `"lcm compact --all"` → rewritten to `"lcm compact --all --hook"` → `hasDuplicates` does NOT fire (`"lcm compact --all --hook" !== "lcm compact --hook"`) → `mergeClaudeSettings` is called only because `rewritten=true`, but does NOT remove `"lcm compact --all --hook"`. Written settings have `"lcm compact --all --hook"` **preserved**.

- [ ] **Step 1: Write the failing tests**

Add to `test/hooks/auto-heal.test.ts`:

```typescript
it("rewrites 'lcm compact' without --hook: entry is removed (matches plugin.json duplicate)", () => {
  // After rewrite: "lcm compact --hook" matches REQUIRED_HOOKS → mergeClaudeSettings removes it.
  // Result: no PreCompact entry in settings.json.
  const deps = makeDeps({
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact" }] }],
      },
    })),
  });
  validateAndFixHooks(deps);
  expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
  const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
  // "lcm compact" (without --hook) must be gone
  const precompact = written.hooks?.PreCompact ?? [];
  const hasOldCommand = precompact.some((e: any) =>
    Array.isArray(e.hooks) && e.hooks.some((h: any) => h.command === "lcm compact")
  );
  expect(hasOldCommand).toBe(false);
});

it("rewrites 'lcm compact --all' to 'lcm compact --all --hook' and preserves it", () => {
  // "lcm compact --all --hook" does not exactly match REQUIRED_HOOKS → preserved.
  const deps = makeDeps({
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --all" }] }],
      },
    })),
  });
  validateAndFixHooks(deps);
  expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
  const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
  const precompact = written.hooks?.PreCompact ?? [];
  const hasRewritten = precompact.some((e: any) =>
    Array.isArray(e.hooks) && e.hooks.some((h: any) => h.command === "lcm compact --all --hook")
  );
  expect(hasRewritten).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run test/hooks/auto-heal.test.ts 2>&1 | tail -20
```

Expected: the 2 new tests FAIL.

- [ ] **Step 3: Implement the rewrite rule in `auto-heal.ts`**

In `validateAndFixHooks`, add the rewrite loop immediately after reading `settings.hooks`, and update the early-return condition:

```typescript
export function validateAndFixHooks(deps: AutoHealDeps = defaultDeps()): void {
  try {
    if (!deps.existsSync(deps.settingsPath)) return;

    const settings: any = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));

    // Hooks are owned by plugin.json — if they leaked into settings.json
    // (from old installer or manual edits), remove them to prevent double-firing.
    const hooks = settings.hooks ?? {};

    // Migration: rewrite "lcm compact" (without --hook) → append "--hook".
    // Uses startsWith to handle user flags like --all that may precede --hook.
    let rewritten = false;
    for (const event of Object.keys(hooks)) {
      if (!Array.isArray(hooks[event])) continue;
      for (const entry of hooks[event]) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (
            typeof h.command === "string" &&
            h.command.startsWith("lcm compact") &&
            !h.command.includes("--hook")
          ) {
            h.command = h.command + " --hook";
            rewritten = true;
          }
        }
      }
    }

    const hasDuplicates = REQUIRED_HOOKS.some(({ event, command }) => {
      const entries = hooks[event];
      return Array.isArray(entries) && hasHookCommand(entries, command);
    });
    if (!hasDuplicates && !rewritten) return;   // ← changed: also write if rewrite happened

    // Clean up: remove lcm hooks from settings.json (MCP config is preserved)
    const merged = mergeClaudeSettings(settings);
    deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
    deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
  } catch (err) {
    try {
      deps.mkdirSync(dirname(deps.logPath), { recursive: true });
      const msg = `[${new Date().toISOString()}] auto-heal error: ${err instanceof Error ? err.message : String(err)}\n`;
      deps.appendFileSync(deps.logPath, msg);
    } catch {
      // Last resort: silently fail
    }
  }
}
```

- [ ] **Step 4: Run all auto-heal tests**

```bash
npx vitest run test/hooks/auto-heal.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all pass (or pre-existing failures only — compare against `git stash && npx vitest run` baseline if uncertain).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/auto-heal.ts test/hooks/auto-heal.test.ts
git commit -m "feat(auto-heal): rewrite 'lcm compact' → 'lcm compact --hook' in settings.json

Migration rule for existing direct installs. Detects any PreCompact hook
command startsWith 'lcm compact' but lacking '--hook' and appends it.
Handles user flags like --all. Early-return updated to also write on rewrite.
Part of fix #90."
```

---

### Task 5: Final verification and build

- [ ] **Step 1: Run full TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 2: Build the package**

```bash
npm run build 2>&1 | tail -20
```

Expected: succeeds.

- [ ] **Step 3: Smoke test — zero-flag non-TTY no longer hangs**

```bash
# Should complete immediately in batch mode (not hang)
echo "" | timeout 5 node dist/lcm.mjs compact 2>&1 | head -5
```

Expected: `Nothing to compact — all sessions are up to date.` (or similar). NOT a hang.

- [ ] **Step 4: Smoke test — `--hook` flag enters dispatch**

```bash
# With --hook: reads stdin JSON, dispatches to daemon (may fail if daemon is down, but must NOT hang)
echo '{}' | timeout 5 node dist/lcm.mjs compact --hook 2>&1 | head -5
```

Expected: completes within 5 seconds.

- [ ] **Step 5: Run full test suite one final time**

```bash
npx vitest run 2>&1 | tail -10
```

---

## Tests Summary

| Area | Case | File |
|------|------|------|
| `bin/lcm.ts` routing | Zero flags → `opts.hook` falsy | `test/bin/compact-routing.test.ts` |
| `bin/lcm.ts` routing | `--hook` flag → `opts.hook` true | `test/bin/compact-routing.test.ts` |
| `bin/lcm.ts` routing | `--hook` + TTY → `opts.hook` true | `test/bin/compact-routing.test.ts` |
| `bin/lcm.ts` routing | `--hook` hidden from help | `test/bin/compact-routing.test.ts` |
| `auto-heal.ts` | `"lcm compact"` → rewritten + removed | `test/hooks/auto-heal.test.ts` |
| `auto-heal.ts` | `"lcm compact --all"` → `"lcm compact --all --hook"` preserved | `test/hooks/auto-heal.test.ts` |
| `install.ts` | `REQUIRED_HOOKS` PreCompact command = `"lcm compact --hook"` | `test/installer/install.test.ts` |

---

## Migration Reference

| Install type | How migrated |
|---|---|
| Plugin install | `plugin.json` updated — takes effect on next Claude Code session |
| Direct install (new) | `installer/install.ts` change — correct from the start |
| Direct install (existing) | `auto-heal.ts` rewrite rule — fires on first PreCompact invocation |
