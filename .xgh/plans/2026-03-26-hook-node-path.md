# Hook Node Path Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `lossless-claude/lcm#140` — move hook ownership from `plugin.json` (static bare `node`) to `settings.json` (absolute `process.execPath` + absolute `lcmMjsPath`) so hooks fire correctly for nvm/Homebrew-ARM/volta/fnm users.

**Architecture:** `settings.json` becomes the sole owner of lcm hooks, mirroring how it already owns the MCP server entry. `mergeClaudeSettings` grows a discriminated-union second arg (`{ intent: "upsert" | "remove" }`). Three write sites keep hooks current: `lcm install` (authoritative), `ensureCore` (self-healing atomic write on every hook invocation), and `lcm.mjs` bootstrap (marketplace coverage). Doctor flips its invariant and adds a `hook-node-path` check.

**Tech Stack:** TypeScript/Node.js, vitest, `node:fs` (`renameSync` for atomic writes), `node:crypto` (`randomBytes` for temp file names).

---

## File Map

| File | Change |
|---|---|
| `src/installer/settings.ts` | New API: `HookOpts` union, `requiredHooks`, `hooksUpToDate`, `isLcmHookCommand`, update `mergeClaudeSettings` |
| `installer/install.ts` | Re-export new helpers; pass `lcmMjsPath` to `ensureCore` |
| `installer/uninstall.ts` | Update `removeClaudeSettings` hook-matching predicate |
| `src/bootstrap.ts` | Add `nodePath`/`lcmMjsPath`/`renameSync` to deps; upsert + atomic write |
| `src/hooks/auto-heal.ts` | Add `nodePath`/`lcmMjsPath` to deps; flip from remove to upsert |
| `src/doctor/doctor.ts` | Flip hook invariant; add `hook-node-path` check with extract helpers |
| `lcm.mjs` | Add guarded hook write after bootstrap (uses `hooksUpToDate`) |
| `.claude-plugin/plugin.json` | Remove entire `hooks` section |
| `test/installer/install.test.ts` | Update `mergeClaudeSettings` tests; add upsert/hooksUpToDate/requiredHooks tests |
| `test/installer/uninstall.test.ts` | Update predicate tests for new absolute-path format |
| `test/bootstrap.test.ts` | Update for upsert + atomic write |
| `test/hooks/auto-heal.test.ts` | Update for upsert behavior |
| `test/doctor/doctor-hooks.test.ts` | Add `hook-node-path` check tests |

---

## Task 1: Refactor `src/installer/settings.ts`

This is the foundation every other task depends on.

**Files:**
- Modify: `src/installer/settings.ts`
- Modify: `test/installer/install.test.ts`

### Step 1.1: Write failing tests for new API

Add these test cases to `test/installer/install.test.ts`. They will fail until Task 1 implementation is complete.

Replace the existing `describe("mergeClaudeSettings", ...)` block with the following (keep all other `describe` blocks unchanged):

```typescript
import {
  mergeClaudeSettings,
  requiredHooks,
  hooksUpToDate,
  resolveBinaryPath,
  install,
  ensureLcmMd,
  REQUIRED_HOOKS,
  type ServiceDeps,
} from "../../installer/install.js";
```

Then add the updated and new `describe` blocks:

```typescript
describe("REQUIRED_HOOKS", () => {
  it("contains exactly 6 hooks with event and subcommand fields", () => {
    expect(REQUIRED_HOOKS).toHaveLength(6);
    expect(REQUIRED_HOOKS.map(h => h.event).sort()).toEqual([
      "PostToolUse", "PreCompact", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
    // All entries must have subcommand, not command
    for (const h of REQUIRED_HOOKS) {
      expect(h).toHaveProperty("subcommand");
      expect(h).not.toHaveProperty("command");
    }
  });
});

describe("requiredHooks", () => {
  it("generates absolute-path commands for all 6 events", () => {
    const hooks = requiredHooks("/usr/bin/node", "/path/to/lcm.mjs");
    expect(hooks).toHaveLength(6);
    expect(hooks[0].command).toMatch(/^"\/usr\/bin\/node" "\/path\/to\/lcm\.mjs" /);
    expect(hooks.every(h => h.command.startsWith('"/usr/bin/node" "/path/to/lcm.mjs" '))).toBe(true);
  });

  it("generates the correct subcommand for PreCompact", () => {
    const hooks = requiredHooks("/n", "/m");
    const precompact = hooks.find(h => h.event === "PreCompact");
    expect(precompact?.command).toBe('"/n" "/m" compact --hook');
  });
});

describe("hooksUpToDate", () => {
  it("returns false when settings has no hooks", () => {
    expect(hooksUpToDate({}, "/n", "/m")).toBe(false);
  });

  it("returns true when all 6 hooks match exactly", () => {
    const settings = mergeClaudeSettings({}, { intent: "upsert", nodePath: "/n", lcmMjsPath: "/m" });
    expect(hooksUpToDate(settings, "/n", "/m")).toBe(true);
  });

  it("returns false when node path differs", () => {
    const settings = mergeClaudeSettings({}, { intent: "upsert", nodePath: "/old", lcmMjsPath: "/m" });
    expect(hooksUpToDate(settings, "/new", "/m")).toBe(false);
  });

  it("returns false when lcmMjsPath differs", () => {
    const settings = mergeClaudeSettings({}, { intent: "upsert", nodePath: "/n", lcmMjsPath: "/old.mjs" });
    expect(hooksUpToDate(settings, "/n", "/new.mjs")).toBe(false);
  });

  it("returns false when only 5 of 6 hooks are present", () => {
    const settings = mergeClaudeSettings({}, { intent: "upsert", nodePath: "/n", lcmMjsPath: "/m" });
    delete settings.hooks.Stop;
    expect(hooksUpToDate(settings, "/n", "/m")).toBe(false);
  });
});

describe("mergeClaudeSettings — intent:upsert", () => {
  it("writes all 6 hooks with quoted absolute paths into empty settings", () => {
    const r = mergeClaudeSettings({}, { intent: "upsert", nodePath: "/node", lcmMjsPath: "/lcm.mjs" });
    expect(Object.keys(r.hooks ?? {})).toHaveLength(6);
    const postTool = r.hooks.PostToolUse[0].hooks[0].command;
    expect(postTool).toBe('"/node" "/lcm.mjs" post-tool');
    const precompact = r.hooks.PreCompact[0].hooks[0].command;
    expect(precompact).toBe('"/node" "/lcm.mjs" compact --hook');
  });

  it("replaces old bare-node commands with absolute-path commands (no duplication)", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "upsert", nodePath: "/node", lcmMjsPath: "/lcm.mjs" });
    const cmds = r.hooks.PreCompact.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toEqual(['"/node" "/lcm.mjs" compact --hook']);
  });

  it("replaces stale absolute-path commands when node path changes", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: '"/old/node" "/lcm.mjs" compact --hook' }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "upsert", nodePath: "/new/node", lcmMjsPath: "/lcm.mjs" });
    const cmds = r.hooks.PreCompact.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).not.toContain('"/old/node" "/lcm.mjs" compact --hook');
    expect(cmds).toContain('"/new/node" "/lcm.mjs" compact --hook');
  });

  it("preserves unrelated hooks in the same event", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "other-tool" }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "upsert", nodePath: "/n", lcmMjsPath: "/m" });
    const cmds = r.hooks.PreCompact.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("other-tool");
    expect(cmds).toContain('"/n" "/m" compact --hook');
  });

  it("does not touch mcpServers.lcm", () => {
    const existing = { mcpServers: { lcm: { command: "lcm", args: ["mcp"] } } };
    const r = mergeClaudeSettings(existing, { intent: "upsert", nodePath: "/n", lcmMjsPath: "/m" });
    expect(r.mcpServers?.lcm).toEqual({ command: "lcm", args: ["mcp"] });
  });
});

describe("mergeClaudeSettings — intent:remove", () => {
  it("removes bare-format lcm hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "remove" });
    expect(r.hooks).toBeUndefined();
  });

  it("removes absolute-path-format lcm hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: '"/node" "/path/to/lcm.mjs" compact --hook' }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "remove" });
    expect(r.hooks).toBeUndefined();
  });

  it("removes lossless-claude legacy hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "remove" });
    expect(r.hooks).toBeUndefined();
  });

  it("preserves unrelated hooks", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "remove" });
    expect(r.hooks?.PreCompact[0].hooks[0].command).toBe("other");
  });

  it("removes only matching managed sub-hooks from a mixed entry", () => {
    const r = mergeClaudeSettings(
      {
        hooks: {
          PreCompact: [{
            matcher: "",
            hooks: [
              { type: "command", command: "other" },
              { type: "command", command: "lcm compact --hook" },
            ],
          }],
        },
      },
      { intent: "remove" },
    );
    expect(r.hooks.PreCompact).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: "other" }],
    }]);
  });

  it("migrates legacy lossless-claude hooks then removes them", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
      },
      mcpServers: {
        "lossless-claude": { command: "lossless-claude", args: ["mcp"] },
        other: { command: "other", args: ["mcp"] },
      },
    };
    const r = mergeClaudeSettings(existing, { intent: "remove" });
    expect(r.hooks?.PreCompact).toBeUndefined();
    expect(r.hooks?.SessionStart).toBeUndefined();
    expect(r.hooks?.PostToolUse).toBeDefined(); // preserved
    expect(r.mcpServers?.["lossless-claude"]).toBeUndefined();
    expect(r.mcpServers?.other).toEqual({ command: "other", args: ["mcp"] });
  });
});
```

- [ ] **Step 1.1:** Add the tests above to `test/installer/install.test.ts`. Replace the existing `describe("mergeClaudeSettings", ...)` block with the new `describe` blocks and update the top-level import to include `requiredHooks` and `hooksUpToDate`.

- [ ] **Step 1.2:** Run tests to confirm they fail:

```bash
npx vitest run test/installer/install.test.ts 2>&1 | tail -20
```

Expected: failures on `requiredHooks`, `hooksUpToDate`, and `mergeClaudeSettings` (wrong signature).

### Step 1.3: Implement the new `src/installer/settings.ts`

Replace the entire file:

```typescript
export const REQUIRED_HOOKS: { event: string; subcommand: string }[] = [
  { event: "PostToolUse", subcommand: "post-tool" },
  { event: "PreCompact", subcommand: "compact --hook" },
  { event: "SessionStart", subcommand: "restore" },
  { event: "SessionEnd", subcommand: "session-end" },
  { event: "UserPromptSubmit", subcommand: "user-prompt" },
  { event: "Stop", subcommand: "session-snapshot" },
];

export type HookOpts =
  | { intent: "remove" }
  | { intent: "upsert"; nodePath: string; lcmMjsPath: string };

export function requiredHooks(
  nodePath: string,
  lcmMjsPath: string,
): Array<{ event: string; command: string }> {
  return REQUIRED_HOOKS.map(({ event, subcommand }) => ({
    event,
    command: `"${nodePath}" "${lcmMjsPath}" ${subcommand}`,
  }));
}

/** Returns true if all 6 required hooks are present in `existing` with matching absolute paths. */
export function hooksUpToDate(
  existing: any,
  nodePath: string,
  lcmMjsPath: string,
): boolean {
  const needed = requiredHooks(nodePath, lcmMjsPath);
  const hooks = existing?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return needed.every(({ event, command }) => {
    const entries = hooks[event];
    return (
      Array.isArray(entries) &&
      entries.some(
        (entry: any) =>
          Array.isArray(entry?.hooks) &&
          entry.hooks.some((h: any) => h.command === command),
      )
    );
  });
}

/** Returns true if `cmd` is an lcm-managed hook command in any known format. */
export function isLcmHookCommand(cmd: string): boolean {
  return (
    cmd.includes("lcm.mjs") ||
    /^"?lcm\s/.test(cmd) ||
    /^"?lossless-claude\s/.test(cmd)
  );
}

export function mergeClaudeSettings(existing: any, opts: HookOpts): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  settings.mcpServers =
    settings.mcpServers &&
    typeof settings.mcpServers === "object" &&
    !Array.isArray(settings.mcpServers)
      ? settings.mcpServers
      : {};

  // Migrate old command strings to current bare form before processing
  const OLD_TO_NEW: Record<string, string> = {
    "lossless-claude compact": "lcm compact --hook",
    "lossless-claude restore": "lcm restore",
    "lossless-claude session-end": "lcm session-end",
    "lossless-claude user-prompt": "lcm user-prompt",
    "lcm compact": "lcm compact --hook",
  };
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    for (const entry of settings.hooks[event]) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h.command && OLD_TO_NEW[h.command]) {
          h.command = OLD_TO_NEW[h.command];
        }
      }
      // Deduplicate within each hook entry after migration
      const seen = new Set<string>();
      entry.hooks = entry.hooks.filter((h: any) => {
        const key = h.command ?? "";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Remove legacy MCP server entry
  delete settings.mcpServers["lossless-claude"];

  if (opts.intent === "remove") {
    // Remove all lcm-managed hooks from settings.json
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event]
        .map((entry: any) => {
          if (!Array.isArray(entry.hooks)) return entry;
          return {
            ...entry,
            hooks: entry.hooks.filter(
              (h: any) => !isLcmHookCommand(h.command ?? ""),
            ),
          };
        })
        .filter(
          (entry: any) =>
            !Array.isArray(entry.hooks) || entry.hooks.length > 0,
        );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  } else {
    // Upsert: ensure all 6 hooks exist with correct absolute paths
    const needed = requiredHooks(opts.nodePath, opts.lcmMjsPath);
    for (const { event, command } of needed) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      // Remove stale lcm entries (old format or wrong absolute paths)
      settings.hooks[event] = settings.hooks[event]
        .map((entry: any) => {
          if (!Array.isArray(entry.hooks)) return entry;
          return {
            ...entry,
            hooks: entry.hooks.filter(
              (h: any) =>
                !isLcmHookCommand(h.command ?? "") || h.command === command,
            ),
          };
        })
        .filter(
          (entry: any) =>
            !Array.isArray(entry.hooks) || entry.hooks.length > 0,
        );
      // Add if not already present
      const alreadyPresent = settings.hooks[event].some(
        (entry: any) =>
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => h.command === command),
      );
      if (!alreadyPresent) {
        settings.hooks[event].push({
          matcher: "",
          hooks: [{ type: "command", command }],
        });
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;

  return settings;
}
```

- [ ] **Step 1.3:** Write the new `src/installer/settings.ts` as shown above.

- [ ] **Step 1.4:** Run tests:

```bash
npx vitest run test/installer/install.test.ts 2>&1 | tail -30
```

Expected: new `mergeClaudeSettings` / `requiredHooks` / `hooksUpToDate` tests pass. Some existing tests may fail because `mergeClaudeSettings` now requires a second arg.

- [ ] **Step 1.5:** Fix the existing `install` function tests that call `mergeClaudeSettings({})` without a second arg. Search for all remaining `mergeClaudeSettings` calls in the test file and update them to pass `{ intent: "remove" }` (the old remove behavior) or `{ intent: "upsert", nodePath: "...", lcmMjsPath: "..." }` as appropriate. The install/uninstall tests should use `intent: "remove"` for the existing cleanup tests.

- [ ] **Step 1.6:** Run tests again until all pass:

```bash
npx vitest run test/installer/install.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 1.7:** Commit:

```bash
git add src/installer/settings.ts test/installer/install.test.ts
git commit -m "feat(settings): discriminated-union HookOpts, requiredHooks, hooksUpToDate, isLcmHookCommand

- REQUIRED_HOOKS shape: { event, subcommand } (was { event, command })
- mergeClaudeSettings now requires HookOpts second arg
- intent:upsert writes absolute-path hooks, removes stale lcm entries
- intent:remove uses isLcmHookCommand predicate (handles all formats)
- New exports: requiredHooks, hooksUpToDate, isLcmHookCommand

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Update `installer/uninstall.ts`

`removeClaudeSettings` matched hooks by exact command string from `REQUIRED_HOOKS.command`. Now that `REQUIRED_HOOKS` has `subcommand` (not `command`) and hooks use absolute paths, the matcher must use `isLcmHookCommand`.

**Files:**
- Modify: `installer/uninstall.ts`
- Modify: `test/installer/uninstall.test.ts`

- [ ] **Step 2.1:** Read the current uninstall test file to understand what needs updating:

```bash
npx vitest run test/installer/uninstall.test.ts 2>&1 | tail -30
```

The tests likely fail because `REQUIRED_HOOKS.map(h => h.command)` now returns `undefined` (the field is now `subcommand`).

- [ ] **Step 2.2:** Update `installer/uninstall.ts`. Replace the `removeClaudeSettings` function body with the predicate-based approach. Change the import and the LC_COMMANDS block:

Replace:
```typescript
import { REQUIRED_HOOKS } from "./install.js";

export function removeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = ...;
  settings.mcpServers = ...;

  const LC_COMMANDS = new Set(REQUIRED_HOOKS.map(h => h.command));
  // Also remove legacy lossless-claude commands
  for (const { command } of REQUIRED_HOOKS) {
    LC_COMMANDS.add(command.replace(/^lcm /, 'lossless-claude '));
  }
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) => !(Array.isArray(entry.hooks) && entry.hooks.some((h: any) => LC_COMMANDS.has(h.command)))
    );
  }
  delete settings.mcpServers["lcm"];
  delete settings.mcpServers["lossless-claude"]; // legacy cleanup
  return settings;
}
```

With:
```typescript
import { isLcmHookCommand } from "../src/installer/settings.js";

export function removeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  settings.mcpServers =
    settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)
      ? settings.mcpServers
      : {};

  // Remove all lcm-managed hooks in any format (bare, absolute-path, legacy)
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) =>
        !(
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => isLcmHookCommand(h.command ?? ""))
        ),
    );
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  delete settings.mcpServers["lcm"];
  delete settings.mcpServers["lossless-claude"];
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;

  return settings;
}
```

- [ ] **Step 2.3:** Update `test/installer/uninstall.test.ts` to test that `removeClaudeSettings` removes both old bare-format and new absolute-path hooks. Add a test case for absolute-path hooks if not already present:

```typescript
it("removes absolute-path-format lcm hooks", () => {
  const existing = {
    hooks: {
      PreCompact: [{
        matcher: "",
        hooks: [{ type: "command", command: '"/path/to/node" "/path/to/lcm.mjs" compact --hook' }],
      }],
    },
  };
  const r = removeClaudeSettings(existing);
  expect(r.hooks).toBeUndefined();
});
```

- [ ] **Step 2.4:** Run tests:

```bash
npx vitest run test/installer/uninstall.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 2.5:** Commit:

```bash
git add installer/uninstall.ts test/installer/uninstall.test.ts
git commit -m "fix(uninstall): update hook-matching predicate for absolute-path format

Old LC_COMMANDS set matched bare 'lcm compact --hook' strings — misses the
new '\"node\" \"lcm.mjs\" compact --hook' absolute-path format.
Now uses isLcmHookCommand predicate which handles all formats.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Update `src/bootstrap.ts` (`ensureCore`)

Switch from removing hooks to upserting them with absolute paths. Add atomic write via `renameSync`.

**Files:**
- Modify: `src/bootstrap.ts`
- Modify: `test/bootstrap.test.ts`

- [ ] **Step 3.1:** Write failing tests. Add these cases to `test/bootstrap.test.ts`:

The `makeDeps` helper must now include `nodePath`, `lcmMjsPath`, and `renameSync`:

```typescript
function makeDeps(overrides: Partial<EnsureCoreDeps> = {}): EnsureCoreDeps {
  return {
    configPath: "/tmp/test-config.json",
    settingsPath: "/tmp/test-settings.json",
    nodePath: "/test/node",
    lcmMjsPath: "/test/lcm.mjs",
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    ...overrides,
  };
}
```

Add new test cases:

```typescript
it("upserts hooks via atomic rename when settings has no lcm hooks", async () => {
  const renameSync = vi.fn();
  const writeFileSync = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync,
    renameSync,
  });
  const { ensureCore } = await import("../src/bootstrap.js");
  await ensureCore(deps);
  // Atomic write: writeFileSync to a .tmp file, then renameSync to settings path
  expect(renameSync).toHaveBeenCalledWith(
    expect.stringMatching(/test-settings\.json\.[a-f0-9]+\.tmp$/),
    deps.settingsPath,
  );
});

it("skips write when hooks already match (hot path)", async () => {
  const renameSync = vi.fn();
  const { mergeClaudeSettings } = await import("../src/installer/settings.js");
  const goodSettings = mergeClaudeSettings(
    {},
    { intent: "upsert", nodePath: "/test/node", lcmMjsPath: "/test/lcm.mjs" },
  );
  const deps = makeDeps({
    existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
    readFileSync: vi.fn().mockReturnValue(JSON.stringify(goodSettings)),
    renameSync,
  });
  const { ensureCore } = await import("../src/bootstrap.js");
  await ensureCore(deps);
  expect(renameSync).not.toHaveBeenCalled();
});

it("upserts hooks with the nodePath and lcmMjsPath from deps", async () => {
  const writeFileSync = vi.fn();
  const renameSync = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync,
    renameSync,
    nodePath: "/custom/node",
    lcmMjsPath: "/custom/lcm.mjs",
  });
  const { ensureCore } = await import("../src/bootstrap.js");
  await ensureCore(deps);
  // The tmp file should contain the correct absolute-path commands
  const tmpWrite = writeFileSync.mock.calls.find(
    (c: any[]) => typeof c[0] === "string" && c[0].endsWith(".tmp"),
  );
  expect(tmpWrite).toBeDefined();
  const written = JSON.parse(tmpWrite![1]);
  const precompact = written.hooks?.PreCompact?.[0]?.hooks?.[0]?.command;
  expect(precompact).toBe('"/custom/node" "/custom/lcm.mjs" compact --hook');
});
```

- [ ] **Step 3.1:** Update `test/bootstrap.test.ts` with the new `makeDeps` and add the three test cases above.

- [ ] **Step 3.2:** Run tests to confirm new cases fail:

```bash
npx vitest run test/bootstrap.test.ts 2>&1 | tail -20
```

- [ ] **Step 3.3:** Implement the changes in `src/bootstrap.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync as fsRenameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeClaudeSettings, hooksUpToDate } from "./installer/settings.js";
import { loadDaemonConfig } from "./daemon/config.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  nodePath: string;
  lcmMjsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: join(homedir(), ".lossless-claude", "config.json"),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    nodePath: process.execPath,
    lcmMjsPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lcm.mjs"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    renameSync: fsRenameSync,
    mkdirSync,
    chmodSync,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

function atomicWriteJSON(
  settingsPath: string,
  data: unknown,
  deps: Pick<EnsureCoreDeps, "writeFileSync" | "renameSync" | "mkdirSync">,
): void {
  const tmp = `${settingsPath}.${randomBytes(6).toString("hex")}.tmp`;
  deps.mkdirSync(dirname(settingsPath), { recursive: true });
  deps.writeFileSync(tmp, JSON.stringify(data, null, 2));
  deps.renameSync(tmp, settingsPath);
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<void> {
  // 1. Create config.json with defaults if missing
  if (!deps.existsSync(deps.configPath)) {
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    const defaults = loadDaemonConfig("/nonexistent");
    deps.writeFileSync(deps.configPath, JSON.stringify(defaults, null, 2));
    try {
      deps.chmodSync?.(deps.configPath, 0o600);
    } catch {}
  }

  // 2. Upsert hooks into settings.json (self-healing)
  // Hot path: read-only string compare. Write only if hooks are missing/stale.
  if (deps.existsSync(deps.settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
      if (!hooksUpToDate(existing, deps.nodePath, deps.lcmMjsPath)) {
        const merged = mergeClaudeSettings(existing, {
          intent: "upsert",
          nodePath: deps.nodePath,
          lcmMjsPath: deps.lcmMjsPath,
        });
        atomicWriteJSON(deps.settingsPath, merged, deps);
      }
    } catch {}
  }

  // 3. Start daemon if not running
  const config = loadDaemonConfig(deps.configPath);
  await deps.ensureDaemon({
    port: config.daemon?.port ?? 3737,
    pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
    spawnTimeoutMs: 5000,
  });
}

export interface BootstrapDeps extends EnsureCoreDeps {
  flagExists: (path: string) => boolean;
  writeFlag: (path: string) => void;
}

function defaultBootstrapDeps(): BootstrapDeps {
  return {
    ...defaultDeps(),
    flagExists: existsSync,
    writeFlag: (p) => writeFileSync(p, ""),
  };
}

export async function ensureBootstrapped(
  sessionId: string,
  deps: BootstrapDeps = defaultBootstrapDeps(),
): Promise<void> {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagDir = join(homedir(), ".lossless-claude", "tmp");
  mkdirSync(flagDir, { recursive: true });
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return;
  } catch {}

  await ensureCore(deps);
  try { deps.writeFlag(flagPath); } catch {}
}
```

- [ ] **Step 3.3:** Write `src/bootstrap.ts` as shown above.

- [ ] **Step 3.4:** Update `test/bootstrap.test.ts` — the existing test "calls mergeClaudeSettings to clean stale hooks" now tests upsert behavior (hooks are written, not removed). Update that test:

```typescript
it("upserts hooks into settings.json when they are absent", async () => {
  const renameSync = vi.fn();
  const writeFileSync = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync,
    renameSync,
  });
  const { ensureCore } = await import("../src/bootstrap.js");
  await ensureCore(deps);
  expect(renameSync).toHaveBeenCalledTimes(1);
  const tmpPath = renameSync.mock.calls[0][0];
  const tmpContent = writeFileSync.mock.calls.find((c: any[]) => c[0] === tmpPath)?.[1];
  const written = JSON.parse(tmpContent);
  expect(written.hooks?.PreCompact?.[0]?.hooks?.[0]?.command).toBe(
    '"/test/node" "/test/lcm.mjs" compact --hook',
  );
});
```

- [ ] **Step 3.5:** Run all tests:

```bash
npx vitest run test/bootstrap.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 3.6:** Run the full suite to check for regressions:

```bash
npx vitest run --reporter=verbose 2>&1 | grep -E "^(FAIL|PASS|✓|✗)" | head -40
```

- [ ] **Step 3.7:** Fix any regressions, then commit:

```bash
git add src/bootstrap.ts test/bootstrap.test.ts
git commit -m "feat(bootstrap): upsert hooks with atomic renameSync, add nodePath/lcmMjsPath deps

- ensureCore now calls mergeClaudeSettings with intent:upsert instead of remove
- atomicWriteJSON: write-to-temp + renameSync (prevents torn JSON on concurrent hook fires)
- Hot path: hooksUpToDate check — no write if all hooks already correct
- EnsureCoreDeps gains nodePath, lcmMjsPath, renameSync fields

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Update `src/hooks/auto-heal.ts`

`validateAndFixHooks` currently removes duplicate hooks; now it upserts them.

**Files:**
- Modify: `src/hooks/auto-heal.ts`
- Modify: `test/hooks/auto-heal.test.ts`

- [ ] **Step 4.1:** Update `test/hooks/auto-heal.test.ts`. The key behavioral change: instead of checking `writeFileSync` was called with removed hooks, check it was called with upserted absolute-path hooks. Update `AutoHealDeps` mock and tests:

```typescript
function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    nodePath: "/test/node",
    lcmMjsPath: "/test/lcm.mjs",
    ...overrides,
  };
}
```

Replace the existing "removes duplicate lcm hooks" test with:

```typescript
it("upserts absolute-path hooks when bare-format hooks are found", () => {
  const deps = makeDeps({
    readFileSync: vi.fn().mockReturnValue(JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
      },
    })),
  });
  validateAndFixHooks(deps);
  expect(deps.renameSync).toHaveBeenCalledTimes(1); // atomic write
  const tmpPath = (deps.renameSync as ReturnType<typeof vi.fn>).mock.calls[0][0];
  const tmpWrite = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: any[]) => c[0] === tmpPath,
  );
  const written = JSON.parse(tmpWrite![1]);
  const precompactCmd = written.hooks.PreCompact?.[0]?.hooks?.[0]?.command;
  expect(precompactCmd).toBe('"/test/node" "/test/lcm.mjs" compact --hook');
  // Unrelated hook preserved
  const postToolCmd = written.hooks.PostToolUse?.[0]?.hooks?.[0]?.command;
  expect(postToolCmd).toBe("other");
});

it("no-ops when all hooks already have correct absolute paths", () => {
  const { mergeClaudeSettings } = require("../../installer/install.js"); // or use import
  // Build correct settings
  // (use inline for clarity)
  const correctSettings = {
    hooks: {
      PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" post-tool' }] }],
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" compact --hook' }] }],
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" restore' }] }],
      SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" session-end' }] }],
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" user-prompt' }] }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: '"/test/node" "/test/lcm.mjs" session-snapshot' }] }],
    },
  };
  const deps = makeDeps({
    readFileSync: vi.fn().mockReturnValue(JSON.stringify(correctSettings)),
  });
  validateAndFixHooks(deps);
  expect(deps.renameSync).not.toHaveBeenCalled();
});
```

Update the "preserves mcpServers.lcm" test to check absolute-path hooks are written.

- [ ] **Step 4.2:** Run tests to confirm failures:

```bash
npx vitest run test/hooks/auto-heal.test.ts 2>&1 | tail -20
```

- [ ] **Step 4.3:** Rewrite `src/hooks/auto-heal.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync as fsRenameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeClaudeSettings, hooksUpToDate } from "../../installer/install.js";

export interface AutoHealDeps {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  appendFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  settingsPath: string;
  logPath: string;
  nodePath: string;
  lcmMjsPath: string;
}

function defaultDeps(): AutoHealDeps {
  return {
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    renameSync: fsRenameSync,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    logPath: join(homedir(), ".lossless-claude", "auto-heal.log"),
    nodePath: process.execPath,
    lcmMjsPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "lcm.mjs"),
  };
}

export function validateAndFixHooks(deps: AutoHealDeps = defaultDeps()): void {
  try {
    if (!deps.existsSync(deps.settingsPath)) return;

    const settings: any = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));

    if (hooksUpToDate(settings, deps.nodePath, deps.lcmMjsPath)) return;

    const merged = mergeClaudeSettings(settings, {
      intent: "upsert",
      nodePath: deps.nodePath,
      lcmMjsPath: deps.lcmMjsPath,
    });

    const tmp = `${deps.settingsPath}.${randomBytes(6).toString("hex")}.tmp`;
    deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
    deps.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    deps.renameSync(tmp, deps.settingsPath);
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

- [ ] **Step 4.4:** Run tests:

```bash
npx vitest run test/hooks/auto-heal.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 4.5:** Commit:

```bash
git add src/hooks/auto-heal.ts test/hooks/auto-heal.test.ts
git commit -m "feat(auto-heal): flip from remove to upsert, add atomic write

validateAndFixHooks now writes correct absolute-path hooks instead of
removing them. Eliminates the oscillation where auto-heal stripped hooks
that ensureCore had just written.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Update `installer/install.ts`

Re-export new helpers from `settings.ts` and pass absolute `lcmMjsPath` when calling `ensureCore`.

**Files:**
- Modify: `installer/install.ts`
- Modify: `test/installer/install.test.ts` (MCP registration test)

- [ ] **Step 5.1:** In `installer/install.ts`, update the re-export line (line 7) to include new exports:

```typescript
export { REQUIRED_HOOKS, mergeClaudeSettings, requiredHooks, hooksUpToDate, isLcmHookCommand } from "../src/installer/settings.js";
```

- [ ] **Step 5.2:** In the `install()` function in `installer/install.ts`, update the `ensureCore` call to pass `nodePath`, `lcmMjsPath`, and `renameSync`. Add the `lcmMjsPath` resolution at the top of the `install` function (after the opening brace):

```typescript
export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
  const lcDir = join(homedir(), ".lossless-claude");
  deps.mkdirSync(lcDir, { recursive: true });

  // Resolve lcmMjsPath from this file's location:
  // dist/installer/install.js → ../../lcm.mjs (package root)
  const lcmMjsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lcm.mjs");

  // ... existing cache-clearing code ...

  // In the ensureCore call, add the new fields:
  await ensureCore({
    configPath,
    settingsPath,
    nodePath: process.execPath,
    lcmMjsPath,
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    writeFileSync: deps.writeFileSync,
    renameSync: fsRenameSync,  // add this import at top of file
    mkdirSync: deps.mkdirSync,
    ensureDaemon: deps.ensureDaemon ?? (async (opts) => {
      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      return ensureDaemon(opts);
    }),
  });
  // ... rest unchanged ...
}
```

Also add `renameSync` to the import at the top of `installer/install.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, chmodSync, renameSync as fsRenameSync } from "node:fs";
```

- [ ] **Step 5.3:** Update `test/installer/install.test.ts` — the install tests construct `ServiceDeps` which doesn't include `renameSync`. The `ensureCore` call inside `install` now needs `renameSync`, but it's not in `ServiceDeps`. Since `install.ts` hard-codes `renameSync: fsRenameSync` (not injectable via ServiceDeps), the tests don't need `renameSync` in `makeDeps`. But if ensureCore writes to a real tmp file in tests, this could fail.

The easiest fix: in tests, the `existsSync` mock returns `false` for `settings.json`, so `ensureCore` won't try to write hooks (since `!deps.existsSync(deps.settingsPath)` is true). The existing test setup already handles this.

Run tests:

```bash
npx vitest run test/installer/install.test.ts 2>&1 | tail -20
```

Expected: all pass (the install function now passes the new deps, but tests mock out `existsSync`).

- [ ] **Step 5.4:** Update the MCP registration test to verify that hooks are written with absolute paths. Add:

```typescript
it("writes hooks with absolute node path to settings.json via ensureCore", async () => {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const written = new Map<string, string>();
  const deps = makeDeps({
    existsSync: vi.fn().mockImplementation((p: string) => p === settingsPath),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
      written.set(path, data);
    }),
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  // Find the settings.json write (may be the tmp file written by atomicWriteJSON)
  const settingsWrite = [...written.entries()].find(([p]) => p.includes("settings.json"));
  expect(settingsWrite).toBeDefined();
  const data = JSON.parse(settingsWrite![1]);
  // Hooks must use absolute node path
  const precompact = data.hooks?.PreCompact?.[0]?.hooks?.[0]?.command;
  expect(precompact).toMatch(/^".*" ".*lcm\.mjs" compact --hook$/);
});
```

- [ ] **Step 5.5:** Run all installer tests:

```bash
npx vitest run test/installer/ 2>&1 | tail -20
```

- [ ] **Step 5.6:** Commit:

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "feat(install): pass absolute nodePath+lcmMjsPath to ensureCore, re-export new helpers

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Update `src/doctor/doctor.ts`

Flip the hook invariant. Replace the current `hooks` check (bad-if-in-settings) with a `hook-node-path` check (good-if-in-settings-with-correct-paths).

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `test/doctor/doctor-hooks.test.ts`

- [ ] **Step 6.1:** Write failing tests for the new `hook-node-path` check. Add to `test/doctor/doctor-hooks.test.ts`:

```typescript
describe("doctor hook-node-path check", () => {
  function makeHookSettings(nodePath: string, lcmMjsPath: string) {
    const { mergeClaudeSettings } = require("../../installer/install.js");
    return mergeClaudeSettings({}, { intent: "upsert", nodePath, lcmMjsPath });
  }

  it("returns fail when no lcm hooks in settings.json", async () => {
    const settings = JSON.stringify({ mcpServers: { lcm: {} } });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const r = results.find(r => r.name === "hook-node-path");
    expect(r?.status).toBe("fail");
    expect(r?.message).toContain("lcm install");
  });

  it("returns ok when hooks match process.execPath and lcmMjsPath exists", async () => {
    const hookSettings = makeHookSettings(process.execPath, "/existing/lcm.mjs");
    const settings = JSON.stringify({ ...hookSettings, mcpServers: { lcm: {} } });
    const results = await runDoctor({
      existsSync: (p: string) => true, // lcmMjsPath exists
      readFileSync: (p: string) => baseReadFileSync(p, settings),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const r = results.find(r => r.name === "hook-node-path");
    expect(r?.status).toBe("ok");
  });

  it("returns warn and repairs when node path is stale", async () => {
    const hookSettings = makeHookSettings("/old/node", "/existing/lcm.mjs");
    const settings = JSON.stringify({ ...hookSettings, mcpServers: { lcm: {} } });
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => {
        if (p.endsWith("settings.json")) return writtenFiles.get(p) ?? settings;
        return baseReadFileSync(p, settings);
      },
      writeFileSync: (p: string, d: string) => { writtenFiles.set(p, d); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const r = results.find(r => r.name === "hook-node-path");
    expect(r?.status).toBe("warn");
    expect(r?.message).toContain("Repaired");
    expect(r?.fixApplied).toBe(true);
  });

  it("returns warn and repairs when lcmMjsPath does not exist on disk", async () => {
    const hookSettings = makeHookSettings(process.execPath, "/deleted/lcm.mjs");
    const settings = JSON.stringify({ ...hookSettings, mcpServers: { lcm: {} } });
    const writtenFiles = new Map<string, string>();
    const results = await runDoctor({
      // existsSync returns false for /deleted/lcm.mjs, true for everything else
      existsSync: (p: string) => !p.includes("/deleted/"),
      readFileSync: (p: string) => {
        if (p.endsWith("settings.json")) return writtenFiles.get(p) ?? settings;
        return baseReadFileSync(p, settings);
      },
      writeFileSync: (p: string, d: string) => { writtenFiles.set(p, d); },
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const r = results.find(r => r.name === "hook-node-path");
    expect(r?.status).toBe("warn");
    expect(r?.message).toContain("lcm.mjs missing");
    expect(r?.fixApplied).toBe(true);
  });
});
```

Also update the existing "reports hooks as passing when they are absent from settings.json" test — after this change, hooks absent from settings.json is a `fail`, not `pass`. Update that test to check the `hook-node-path` result instead of `hooks`.

- [ ] **Step 6.2:** Run tests to confirm failures:

```bash
npx vitest run test/doctor/doctor-hooks.test.ts 2>&1 | tail -30
```

- [ ] **Step 6.3:** Implement changes in `src/doctor/doctor.ts`.

Add two parsing helpers just before `runDoctor` (they are internal, not exported):

```typescript
/** Extracts the node binary path from an absolute-path hook command. */
function extractNodeFromHookCommand(cmd: string): string | null {
  return cmd.match(/^"([^"]+)"/)?.[1] ?? null;
}

/** Extracts the lcm.mjs path from an absolute-path hook command. */
function extractLcmMjsFromHookCommand(cmd: string): string | null {
  return cmd.match(/^"[^"]*"\s+"([^"]+)"/)?.[1] ?? null;
}
```

Replace the `// ── Settings ──` hooks block (lines 299–345 in the original file) with the new version:

**Remove** the old `hooks` check block (lines 306–345):
```typescript
// Hooks are owned by plugin.json, not settings.json.
// If hooks leaked into settings.json (old installer), clean them up.
...
```

**Replace** it with:
```typescript
// ── Hook node path ──
// Hooks are now owned by settings.json. Check they exist with correct absolute paths.
const lcmHooks = settingsData?.hooks as Record<string, any[]> | undefined;

// Find any hook entry from the first required event (PreCompact) as a sample
const sampleEntries = lcmHooks?.["PreCompact"];
const sampleCmd = sampleEntries?.flatMap((e: any) =>
  Array.isArray(e?.hooks) ? e.hooks.map((h: any) => h.command ?? "") : []
).find((c: string) => c.includes("lcm.mjs") || /^"/.test(c));

const hookNode = sampleCmd ? extractNodeFromHookCommand(sampleCmd) : null;
const hookMjs = sampleCmd ? extractLcmMjsFromHookCommand(sampleCmd) : null;

if (!hookNode || !hookMjs) {
  results.push({
    name: "hook-node-path",
    category: "Settings",
    status: "fail",
    message: "lcm hooks missing from settings.json — run: lcm install",
  });
} else {
  const staleNode = hookNode !== process.execPath;
  const staleMjs = !deps.existsSync(hookMjs);

  if (staleNode || staleMjs) {
    try {
      // Resolve correct lcmMjsPath from this binary's location
      const lcmMjsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "lcm.mjs");
      const repairedSettings = mergeClaudeSettings(currentSettings, {
        intent: "upsert",
        nodePath: process.execPath,
        lcmMjsPath,
      });
      deps.writeFileSync(settingsPath, JSON.stringify(repairedSettings, null, 2));
      const reason = staleNode
        ? `node path was ${hookNode}`
        : `lcm.mjs missing at ${hookMjs}${pkgVersion ? ` (plugin updated to v${pkgVersion})` : ""}`;
      results.push({
        name: "hook-node-path",
        category: "Settings",
        status: "warn",
        message: `Repaired hooks (${reason})`,
        fixApplied: true,
      });
    } catch {
      results.push({
        name: "hook-node-path",
        category: "Settings",
        status: "fail",
        message: "Hook paths stale — run: lcm install",
      });
    }
  } else {
    results.push({
      name: "hook-node-path",
      category: "Settings",
      status: "ok",
      message: `hooks registered (${hookNode.split("/").pop()})`,
    });
  }
}
```

Also update the `hooksInstalled` predicate (used for passive learning gate):

```typescript
const hooksInstalled = results.some(
  r => r.category === "Settings" && r.name === "hook-node-path" && r.status !== "fail"
);
```

- [ ] **Step 6.4:** Run doctor tests:

```bash
npx vitest run test/doctor/ 2>&1 | tail -30
```

- [ ] **Step 6.5:** Fix any failures. The key is that `mergeClaudeSettings` in doctor now requires `{ intent: ... }` as second arg. Find all doctor.ts calls to `mergeClaudeSettings` and update them.

- [ ] **Step 6.6:** Run full test suite to check regressions:

```bash
npx vitest run --reporter=verbose 2>&1 | grep -E "FAIL" | head -20
```

- [ ] **Step 6.7:** Commit:

```bash
git add src/doctor/doctor.ts test/doctor/doctor-hooks.test.ts
git commit -m "feat(doctor): flip hook invariant — add hook-node-path check

Before: hooks in settings.json = bad (remove them, plugin.json owns them)
After: hooks in settings.json = expected (check node path + lcmMjsPath exist)

New check 'hook-node-path':
- fail: hooks missing from settings.json
- warn+repair: node path stale or lcm.mjs deleted (plugin version bump)
- ok: hooks match process.execPath and lcmMjsPath exists on disk

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Update `lcm.mjs` bootstrap write

After building `dist/`, write hooks to `settings.json` if they are missing or stale. Guard with `hooksUpToDate` to avoid writing on every invocation.

**Files:**
- Modify: `lcm.mjs`

- [ ] **Step 7.1:** Read the current `lcm.mjs` fully to find the right insertion point. The hook write should happen AFTER the `dist/` build succeeds (i.e., inside the `if (!existsSync(join(__dirname, "dist")))` block, after `npm run build`).

- [ ] **Step 7.2:** Add the following imports at the top of `lcm.mjs` (alongside existing `existsSync`):

```javascript
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
```

- [ ] **Step 7.3:** Add a shared `atomicWriteJSON` helper near the top of `lcm.mjs` (after the existing imports):

```javascript
import { randomBytes } from "node:crypto";

function atomicWriteJSON(filePath, data) {
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}
```

- [ ] **Step 7.4:** Inside the `if (!existsSync(join(__dirname, "dist"))) { ... }` block, after the `execSync("npm run build ...")` call succeeds, add the guarded hook write:

```javascript
// Write hooks to settings.json if missing or stale (marketplace-install coverage).
// Guard: only writes if hooksUpToDate returns false — safe to call on every boot.
try {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const { mergeClaudeSettings, hooksUpToDate } = await import(
    "./dist/src/installer/settings.js"
  );
  const lcmMjsPath = fileURLToPath(import.meta.url);
  const existing = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};
  if (!hooksUpToDate(existing, process.execPath, lcmMjsPath)) {
    const merged = mergeClaudeSettings(existing, {
      intent: "upsert",
      nodePath: process.execPath,
      lcmMjsPath,
    });
    atomicWriteJSON(settingsPath, merged);
  }
} catch {
  // Best-effort — never block hook execution
}
```

Place this INSIDE the `try {}` of the dist-build block (after `execSync("npm run build...")`), so it only runs when a fresh build just completed.

- [ ] **Step 7.5:** Verify `lcm.mjs` still runs without error:

```bash
node lcm.mjs --help 2>&1 | head -5
```

Expected: shows usage (no crash).

- [ ] **Step 7.6:** Commit:

```bash
git add lcm.mjs
git commit -m "feat(lcm.mjs): write absolute-path hooks after fresh bootstrap build

Marketplace installs that don't run 'lcm install' now get hooks registered
on first lcm.mjs invocation (when dist/ is built). Guard prevents write on
subsequent invocations when hooksUpToDate returns true.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Remove `hooks` from `.claude-plugin/plugin.json`

**Files:**
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 8.1:** Remove the entire `hooks` block from `.claude-plugin/plugin.json`. The file should become:

```json
{
  "name": "lcm",
  "version": "0.7.0",
  "description": "Lossless context management — DAG-based summarization that preserves every message",
  "author": {
    "name": "Pedro Almeida",
    "url": "https://github.com/ipedro"
  },
  "homepage": "https://lossless-claude.com",
  "repository": "https://github.com/lossless-claude/lcm",
  "license": "MIT",
  "keywords": ["context", "memory", "compaction", "summarization", "lcm"],
  "commands": "./.claude-plugin/commands/",
  "mcpServers": {
    "lcm": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp.mjs"]
    }
  }
}
```

- [ ] **Step 8.2:** Run the full test suite one final time to confirm no regressions:

```bash
npx vitest run 2>&1 | tail -10
```

Expected: same or better pass count as before this plan.

- [ ] **Step 8.3:** Commit:

```bash
git add .claude-plugin/plugin.json
git commit -m "feat(plugin.json): remove hooks section — settings.json now owns hooks

Claude Code registered bare-node hooks from this file, which failed for
nvm/volta/Homebrew-ARM users whose node is not on the system default PATH.
Hooks are now written to settings.json with absolute process.execPath at
install time and self-healed by ensureCore on every hook invocation.

Fixes lossless-claude/lcm#140

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage check:**

| Spec Section | Task |
|---|---|
| `settings.ts` — `HookOpts`, `requiredHooks`, `hooksUpToDate` | Task 1 |
| `settings.ts` — `intent: "remove"` uses `isLcmHookCommand` | Task 1 |
| `settings.ts` — `intent: "upsert"` writes correct paths, removes stale | Task 1 |
| Migration `OLD_TO_NEW` for bare-node plugin.json commands | Task 1 |
| `installer/uninstall.ts` — new hook-matching predicate | Task 2 |
| `src/bootstrap.ts` — upsert + atomic `renameSync` write | Task 3 |
| `src/bootstrap.ts` — hot path: `hooksUpToDate` guard, no write | Task 3 |
| `src/hooks/auto-heal.ts` — flip from remove to upsert | Task 4 |
| `installer/install.ts` — pass `process.execPath` + `lcmMjsPath` | Task 5 |
| `src/doctor/doctor.ts` — flip invariant, `hook-node-path` check | Task 6 |
| `src/doctor/doctor.ts` — `extractNodeFromHookCommand` / `extractLcmMjsFromHookCommand` defined | Task 6 |
| Doctor checks `existsSync(hookMjs)` for staleness | Task 6 |
| `lcm.mjs` — guarded hook write after bootstrap, uses `hooksUpToDate` | Task 7 |
| `.claude-plugin/plugin.json` — `hooks` section removed | Task 8 |
| Unit tests for all new behaviors | Tasks 1–6 |

**No placeholders detected.** All steps include exact code.

**Type consistency:** `REQUIRED_HOOKS[i].subcommand` used in `requiredHooks()` → `mergeClaudeSettings` `intent: "upsert"` → `hooksUpToDate` → `ensureCore`/`auto-heal`/`lcm.mjs` → consistent throughout.
