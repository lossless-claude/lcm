# Hook Auto-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix conversation ingestion by registering all 4 hooks, adding auto-heal to every hook entry point, and providing an upgrade skill.

**Architecture:** Single source of truth (`REQUIRED_HOOKS` constant) drives installer, uninstaller, doctor, and auto-heal. A shared `validateAndFixHooks()` runs from every hook CLI path via an extracted `dispatchHook()` function. Upgrade skill provides manual recovery.

**Tech Stack:** TypeScript, Vitest, Claude Code plugin system (hooks, skills)

**Spec:** `.xgh/specs/2026-03-21-hook-auto-heal-design.md` (rev 4)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `installer/install.ts` | `REQUIRED_HOOKS` constant, `mergeClaudeSettings()` |
| `installer/uninstall.ts` | `removeClaudeSettings()` using `REQUIRED_HOOKS` |
| `src/hooks/auto-heal.ts` | `validateAndFixHooks()` — shared hook repair |
| `src/hooks/dispatch.ts` | `dispatchHook()`, `HOOK_COMMANDS` — testable hook dispatcher |
| `bin/lossless-claude.ts` | CLI entry — delegates hook cases to `dispatchHook()` |
| `src/doctor/doctor.ts` | Hook validation loop using `REQUIRED_HOOKS` |
| `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md` | Upgrade skill definition |
| `README.md` | Hook documentation |

---

### Task 1: REQUIRED_HOOKS constant + mergeClaudeSettings refactor

**Files:**
- Modify: `installer/install.ts:6-41`
- Test: `test/installer/install.test.ts`

- [ ] **Step 1: Write failing tests for all 4 hooks**

Add to `test/installer/install.test.ts` in the `mergeClaudeSettings` describe block:

```ts
it("registers all 4 required hooks on empty settings", () => {
  const r = mergeClaudeSettings({});
  expect(r.hooks.PreCompact).toHaveLength(1);
  expect(r.hooks.SessionStart).toHaveLength(1);
  expect(r.hooks.SessionEnd).toHaveLength(1);
  expect(r.hooks.UserPromptSubmit).toHaveLength(1);
  expect(r.hooks.SessionEnd[0]).toEqual({
    matcher: "",
    hooks: [{ type: "command", command: "lossless-claude session-end" }],
  });
  expect(r.hooks.UserPromptSubmit[0]).toEqual({
    matcher: "",
    hooks: [{ type: "command", command: "lossless-claude user-prompt" }],
  });
});

it("REQUIRED_HOOKS contains exactly 4 expected events", () => {
  expect(REQUIRED_HOOKS.map(h => h.event).sort()).toEqual([
    "PreCompact", "SessionEnd", "SessionStart", "UserPromptSubmit",
  ]);
});

it("does not duplicate any of the 4 hooks if already present", () => {
  const existing = {
    hooks: {
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] }],
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] }],
      SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude session-end" }] }],
      UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude user-prompt" }] }],
    },
  };
  const r = mergeClaudeSettings(existing);
  for (const event of ["PreCompact", "SessionStart", "SessionEnd", "UserPromptSubmit"]) {
    expect(r.hooks[event]).toHaveLength(1);
  }
});
```

Import `REQUIRED_HOOKS` at the top of the test file alongside the existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/installer/install.test.ts --reporter=verbose`
Expected: FAIL — `REQUIRED_HOOKS` not exported, SessionEnd/UserPromptSubmit not in result

- [ ] **Step 3: Implement REQUIRED_HOOKS and refactor mergeClaudeSettings**

In `installer/install.ts`, replace lines 6-41 (the constants, helpers, and `mergeClaudeSettings` function) with:

```ts
export const REQUIRED_HOOKS: { event: string; command: string }[] = [
  { event: "PreCompact", command: "lossless-claude compact" },
  { event: "SessionStart", command: "lossless-claude restore" },
  { event: "SessionEnd", command: "lossless-claude session-end" },
  { event: "UserPromptSubmit", command: "lossless-claude user-prompt" },
];

const LC_MCP = { command: "lossless-claude", args: ["mcp"] };

function makeHookEntry(command: string): { matcher: string; hooks: { type: string; command: string }[] } {
  return { matcher: "", hooks: [{ type: "command", command }] };
}

function hasHookCommand(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command === command)
  );
}

export function mergeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = settings.hooks ?? {};
  settings.mcpServers = settings.mcpServers ?? {};

  for (const { event, command } of REQUIRED_HOOKS) {
    settings.hooks[event] = settings.hooks[event] ?? [];
    if (!hasHookCommand(settings.hooks[event], command)) {
      settings.hooks[event].push(makeHookEntry(command));
    }
  }

  settings.mcpServers["lossless-claude"] = LC_MCP;
  return settings;
}
```

Also update the existing test at line 34-39 to assert all 4 hooks (the first test in the describe block — it currently only checks PreCompact and SessionStart).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/installer/install.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "feat: register all 4 hooks via REQUIRED_HOOKS constant"
```

---

### Task 2: Uninstall path fix

**Files:**
- Modify: `installer/uninstall.ts:11`
- Test: `test/installer/uninstall.test.ts`

- [ ] **Step 1: Write failing test for 4-hook removal**

Add to `test/installer/uninstall.test.ts` in the `removeClaudeSettings` describe block:

```ts
it("removes all 4 lossless-claude hook events", () => {
  const r = removeClaudeSettings({
    hooks: {
      PreCompact: [
        { matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] },
      ],
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] },
      ],
      SessionEnd: [
        { matcher: "", hooks: [{ type: "command", command: "lossless-claude session-end" }] },
      ],
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: "lossless-claude user-prompt" }] },
      ],
    },
    mcpServers: { "lossless-claude": {} },
  });
  expect(r.hooks.PreCompact).toHaveLength(0);
  expect(r.hooks.SessionStart).toHaveLength(0);
  expect(r.hooks.SessionEnd).toHaveLength(0);
  expect(r.hooks.UserPromptSubmit).toHaveLength(0);
  expect(r.mcpServers["lossless-claude"]).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/installer/uninstall.test.ts --reporter=verbose`
Expected: FAIL — SessionEnd and UserPromptSubmit entries not removed (still length 1)

- [ ] **Step 3: Fix removeClaudeSettings to use REQUIRED_HOOKS**

In `installer/uninstall.ts`, replace line 11:

```ts
// Before:
const LC_COMMANDS = new Set(["lossless-claude compact", "lossless-claude restore"]);

// After:
import { REQUIRED_HOOKS } from "./install.js";
const LC_COMMANDS = new Set(REQUIRED_HOOKS.map(h => h.command));
```

Remove the static import and use the dynamic one. The import goes at the top of the file with the other imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/installer/uninstall.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add installer/uninstall.ts test/installer/uninstall.test.ts
git commit -m "fix: uninstall removes all 4 hook events via REQUIRED_HOOKS"
```

---

### Task 3: auto-heal module

**Files:**
- Create: `src/hooks/auto-heal.ts`
- Test: `test/hooks/auto-heal.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/hooks/auto-heal.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateAndFixHooks, type AutoHealDeps } from "../../src/hooks/auto-heal.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

function makeDeps(overrides: Partial<AutoHealDeps> = {}): AutoHealDeps {
  return {
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    settingsPath: "/tmp/test-settings.json",
    logPath: "/tmp/test-auto-heal.log",
    ...overrides,
  };
}

describe("validateAndFixHooks", () => {
  it("fixes missing hooks in settings.json", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({
        hooks: {
          PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] }],
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] }],
        },
      })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse((deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(written.hooks.SessionEnd).toHaveLength(1);
    expect(written.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("no-ops when all hooks present", () => {
    const allHooks: Record<string, any[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) {
      allHooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
    }
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ hooks: allHooks })),
    });
    validateAndFixHooks(deps);
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not throw on fs errors", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
  });

  it("logs errors to auto-heal.log", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    validateAndFixHooks(deps);
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("ENOENT"),
    );
  });

  it("handles corrupt settings.json gracefully", () => {
    const deps = makeDeps({
      readFileSync: vi.fn().mockReturnValue("not valid json {{{"),
    });
    expect(() => validateAndFixHooks(deps)).not.toThrow();
    expect(deps.appendFileSync).toHaveBeenCalledWith(
      deps.logPath,
      expect.stringContaining("auto-heal error"),
    );
  });

  it("handles missing settings.json gracefully", () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
    });
    validateAndFixHooks(deps);
    // Should create settings with all hooks
    expect(deps.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/hooks/auto-heal.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement auto-heal module**

Create `src/hooks/auto-heal.ts`:

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { REQUIRED_HOOKS, mergeClaudeSettings } from "../../installer/install.js";

export interface AutoHealDeps {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  appendFileSync: (path: string, data: string) => void;
  settingsPath: string;
  logPath: string;
}

function defaultDeps(): AutoHealDeps {
  return {
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    logPath: join(homedir(), ".lossless-claude", "auto-heal.log"),
  };
}

function hasHookCommand(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command === command)
  );
}

export function validateAndFixHooks(deps: AutoHealDeps = defaultDeps()): void {
  try {
    let settings: any = {};
    if (deps.existsSync(deps.settingsPath)) {
      settings = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
    }

    const hooks = settings.hooks ?? {};
    const allPresent = REQUIRED_HOOKS.every(({ event, command }) => {
      const entries = hooks[event];
      return Array.isArray(entries) && hasHookCommand(entries, command);
    });

    if (allPresent) return;

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/hooks/auto-heal.test.ts --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/auto-heal.ts test/hooks/auto-heal.test.ts
git commit -m "feat: add auto-heal module for hook validation and repair"
```

---

### Task 4: Extract dispatchHook from CLI

**Files:**
- Create: `src/hooks/dispatch.ts`
- Modify: `bin/lossless-claude.ts:61-116`
- Test: `test/hooks/dispatch.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/hooks/dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { HOOK_COMMANDS } from "../../src/hooks/dispatch.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock auto-heal to verify it's called
vi.mock("../../src/hooks/auto-heal.js", () => ({
  validateAndFixHooks: vi.fn(),
}));

// Mock all handler modules to avoid real daemon connections
vi.mock("../../src/hooks/compact.js", () => ({
  handlePreCompact: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/restore.js", () => ({
  handleSessionStart: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/session-end.js", () => ({
  handleSessionEnd: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/user-prompt.js", () => ({
  handleUserPromptSubmit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ daemon: { port: 3737 } }),
}));

import { validateAndFixHooks } from "../../src/hooks/auto-heal.js";
import { dispatchHook } from "../../src/hooks/dispatch.js";

describe("HOOK_COMMANDS", () => {
  it("has an entry for every REQUIRED_HOOKS event", () => {
    const commandToEvent: Record<string, string> = {
      "compact": "PreCompact",
      "restore": "SessionStart",
      "session-end": "SessionEnd",
      "user-prompt": "UserPromptSubmit",
    };
    for (const cmd of HOOK_COMMANDS) {
      expect(commandToEvent[cmd]).toBeDefined();
    }
    for (const { event } of REQUIRED_HOOKS) {
      const cmd = Object.entries(commandToEvent).find(([, e]) => e === event)?.[0];
      expect(HOOK_COMMANDS).toContain(cmd);
    }
  });
});

import { handlePreCompact } from "../../src/hooks/compact.js";
import { handleSessionStart } from "../../src/hooks/restore.js";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

describe("dispatchHook", () => {
  it("calls validateAndFixHooks before every handler", async () => {
    const callOrder: string[] = [];
    vi.mocked(validateAndFixHooks).mockImplementation(() => { callOrder.push("heal"); });
    vi.mocked(handlePreCompact).mockImplementation(async () => { callOrder.push("handler"); return { exitCode: 0, stdout: "" }; });

    callOrder.length = 0;
    await dispatchHook("compact", "{}");
    expect(callOrder).toEqual(["heal", "handler"]);
  });

  it("dispatches each command to its correct handler", async () => {
    const mapping: [typeof HOOK_COMMANDS[number], any][] = [
      ["compact", handlePreCompact],
      ["restore", handleSessionStart],
      ["session-end", handleSessionEnd],
      ["user-prompt", handleUserPromptSubmit],
    ];
    for (const [cmd, handler] of mapping) {
      vi.mocked(handler).mockClear();
      await dispatchHook(cmd, '{"test":true}');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('{"test":true}', expect.anything(), expect.any(Number));
    }
  });

  it("passes configured port to handlers", async () => {
    vi.mocked(loadDaemonConfig).mockReturnValue({ daemon: { port: 9999 } } as any);
    await dispatchHook("compact", "{}");
    expect(handlePreCompact).toHaveBeenCalledWith("{}", expect.anything(), 9999);
    // Reset to default
    vi.mocked(loadDaemonConfig).mockReturnValue({ daemon: { port: 3737 } } as any);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/dispatch.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement dispatch module**

Create `src/hooks/dispatch.ts`:

```ts
import { validateAndFixHooks } from "./auto-heal.js";

export const HOOK_COMMANDS = ["compact", "restore", "session-end", "user-prompt"] as const;
export type HookCommand = typeof HOOK_COMMANDS[number];

export function isHookCommand(cmd: string): cmd is HookCommand {
  return (HOOK_COMMANDS as readonly string[]).includes(cmd);
}

export async function dispatchHook(
  command: HookCommand,
  stdinText: string,
): Promise<{ exitCode: number; stdout: string }> {
  validateAndFixHooks();

  const { DaemonClient } = await import("../daemon/client.js");
  const { loadDaemonConfig } = await import("../daemon/config.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
  const port = config.daemon?.port ?? 3737;
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  switch (command) {
    case "compact": {
      const { handlePreCompact } = await import("./compact.js");
      return handlePreCompact(stdinText, client, port);
    }
    case "restore": {
      const { handleSessionStart } = await import("./restore.js");
      return handleSessionStart(stdinText, client, port);
    }
    case "session-end": {
      const { handleSessionEnd } = await import("./session-end.js");
      return handleSessionEnd(stdinText, client, port);
    }
    case "user-prompt": {
      const { handleUserPromptSubmit } = await import("./user-prompt.js");
      return handleUserPromptSubmit(stdinText, client, port);
    }
  }
}
```

- [ ] **Step 4: Update bin/lossless-claude.ts to use dispatchHook**

Replace the 4 hook cases (lines 61-116) in the switch statement with:

```ts
    case "compact":
    case "restore":
    case "session-end":
    case "user-prompt": {
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook(command, input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
```

- [ ] **Step 5: Run all tests to verify nothing broke**

Run: `npx vitest run --reporter=verbose`
Expected: All existing + new tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/dispatch.ts test/hooks/dispatch.test.ts bin/lossless-claude.ts
git commit -m "refactor: extract dispatchHook with auto-heal on every hook path"
```

---

### Task 5: Doctor update

**Files:**
- Modify: `src/doctor/doctor.ts:164-183`
- Test: `test/doctor/doctor.test.ts` (or existing test file)

- [ ] **Step 1: Update doctor hook validation to use REQUIRED_HOOKS**

In `src/doctor/doctor.ts`, replace the hardcoded hook checks at lines 164-183 (keep the settings-reading code at lines 158-163 intact). Replace starting from `const hooks = ...`:

```ts
  const hooks = settingsData.hooks as Record<string, unknown[]> | undefined;
  const missingHooks: string[] = [];
  const presentHooks: string[] = [];

  for (const { event, command } of REQUIRED_HOOKS) {
    const entries = hooks?.[event];
    const found = Array.isArray(entries) && entries.some((e: unknown) =>
      JSON.stringify(e).includes(command)
    );
    if (found) {
      presentHooks.push(event);
    } else {
      missingHooks.push(event);
    }
  }

  if (missingHooks.length === 0) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: presentHooks.map(e => `${e} \u2713`).join("  "),
    });
  } else {
    try {
      const merged = mergeClaudeSettings(settingsData);
      deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Missing ${missingHooks.join(", ")} — fixed`,
        fixApplied: true,
      });
    } catch {
      results.push({
        name: "hooks",
        category: "Settings",
        status: "fail",
        message: `Missing ${missingHooks.join(", ")} — run: lossless-claude install`,
      });
    }
  }
```

Add import at the top of the file:

```ts
import { REQUIRED_HOOKS } from "../../installer/install.js";
```

(The file already imports `mergeClaudeSettings` from the same path.)

- [ ] **Step 2: Add doctor hook validation test**

Add to the existing doctor test file (or create `test/doctor/doctor-hooks.test.ts`):

```ts
import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../../src/doctor/doctor.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

describe("doctor hook validation", () => {
  it("reports all 4 hooks as passing when all present", async () => {
    const allHooks: Record<string, any[]> = {};
    for (const { event, command } of REQUIRED_HOOKS) {
      allHooks[event] = [{ matcher: "", hooks: [{ type: "command", command }] }];
    }
    const settings = JSON.stringify({ hooks: allHooks, mcpServers: { "lossless-claude": {} } });
    const results = await runDoctor({
      existsSync: () => true,
      readFileSync: (p: string) => {
        if (p.endsWith("config.json")) return JSON.stringify({ llm: { provider: "claude-process" } });
        if (p.endsWith("settings.json")) return settings;
        if (p.endsWith("package.json")) return JSON.stringify({ version: "0.5.0" });
        return "{}";
      },
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      fetch: vi.fn().mockResolvedValue({ ok: false }),  // daemon "down" to skip MCP handshake
      homedir: "/tmp/test-home",
      platform: "darwin",
    });
    const hookResult = results.find(r => r.name === "hooks");
    expect(hookResult?.status).toBe("pass");
    expect(hookResult?.message).toContain("SessionEnd");
    expect(hookResult?.message).toContain("UserPromptSubmit");
  });
});
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/doctor/doctor.ts test/doctor/
git commit -m "fix: doctor validates all 4 hooks via REQUIRED_HOOKS"
```

---

### Task 6: Upgrade skill

**Files:**
- Create: `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md`

- [ ] **Step 1: Create the upgrade skill**

Create `.claude-plugin/skills/lossless-claude-upgrade/SKILL.md`:

```markdown
---
name: lossless-claude-upgrade
description: |
  Rebuild, reinstall, and restart lossless-claude from source.
  Fixes hooks, restarts daemon, runs diagnostics.
  Trigger: /lossless-claude:upgrade
user-invocable: true
---

# lossless-claude Upgrade

Rebuild from source, restart daemon, and verify installation.

## Instructions

1. Derive the **repo root** from this skill's base directory (go up 3 levels — remove `/skills/lossless-claude-upgrade` from the path, then remove `.claude-plugin`).
2. Run with Bash:
   ```
   cd <REPO_ROOT> && npm run build && npm link
   ```
3. Restart daemon with Bash:
   ```
   PID_FILE="$HOME/.lossless-claude/daemon.pid"
   if [ -f "$PID_FILE" ]; then
     PID=$(cat "$PID_FILE")
     if ps -p "$PID" -o args= 2>/dev/null | grep -q 'lossless-claude.*daemon'; then
       kill "$PID" 2>/dev/null
     fi
     rm -f "$PID_FILE"
   fi
   lossless-claude daemon start --detach
   ```
4. Run doctor with Bash:
   ```
   lossless-claude doctor
   ```
5. **IMPORTANT**: After all Bash commands complete, re-display key results as markdown text directly in the conversation. Format as:
   ```
   ## lossless-claude upgrade
   - [x] Built from source
   - [x] npm linked globally
   - [x] Daemon restarted (PID XXXX)
   - [x] Hooks configured
   - [x] Doctor: all checks PASS
   ```
   Use `[x]` for success, `[ ]` for failure. Show actual version and any warnings.
   Tell the user to **restart their Claude Code session** to pick up the new version.
```

- [ ] **Step 2: Verify plugin.json references skills directory**

Check that `.claude-plugin/plugin.json` does not need a `"skills"` field — Claude Code auto-discovers skills from the `skills/` directory inside the plugin root. No manifest change needed.

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/skills/lossless-claude-upgrade/SKILL.md
git commit -m "feat: add /lossless-claude:upgrade skill for manual recovery"
```

---

### Task 7: README update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update hook documentation**

At line ~75, change:

```
Both methods register the plugin's hooks (PreCompact, SessionStart) and MCP server automatically.
```

to:

```
Both methods register the plugin's hooks (PreCompact, SessionStart, SessionEnd, UserPromptSubmit) and MCP server automatically.
```

At lines ~142-143, update the CLI section to include all hook commands:

```
lossless-claude compact          # Handle PreCompact hook (stdin)
lossless-claude restore          # Handle SessionStart hook (stdin)
lossless-claude session-end      # Handle SessionEnd hook (stdin)
lossless-claude user-prompt      # Handle UserPromptSubmit hook (stdin)
```

At lines ~183-184, update the file tree to include all hook files:

```
  hooks/
    auto-heal.ts              # Hook validation and auto-repair
    compact.ts                # PreCompact hook handler
    dispatch.ts               # Hook dispatcher with auto-heal wiring
    restore.ts                # SessionStart hook handler
    session-end.ts            # SessionEnd hook handler
    user-prompt.ts            # UserPromptSubmit hook handler
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document all 4 hooks and new files"
```

---

### Task 8: Changeset + build

**Files:**
- Modify: `.changeset/cross-project-improvements.md`

- [ ] **Step 1: Append fix to existing changeset**

Add to `.changeset/cross-project-improvements.md` under the existing Fixes section:

```markdown
- Register all 4 hooks in settings.json (SessionEnd, UserPromptSubmit were missing — conversations not ingested)
- Auto-heal: every hook CLI entry point validates and repairs missing hooks on each invocation
- Upgrade skill (`/lossless-claude:upgrade`) for manual rebuild/restart/doctor
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean TypeScript compilation

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Step 4: Commit build artifacts and changeset**

```bash
git add .changeset/cross-project-improvements.md dist/
git commit -m "chore: update changeset and rebuild dist"
```

---

### Task 9: Smoke test

- [ ] **Step 1: Verify auto-heal fixes current installation**

Run: `lossless-claude doctor`
Expected: Should show all 4 hooks as passing (auto-fixed if needed)

- [ ] **Step 2: Verify daemon restarts with correct version**

Run:
```bash
PID_FILE="$HOME/.lossless-claude/daemon.pid"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ps -p "$PID" -o args= 2>/dev/null | grep -q 'lossless-claude.*daemon'; then
    kill "$PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
fi
lossless-claude daemon start --detach
sleep 2
lossless-claude status
```
Expected: `daemon: up · provider: claude-process` (confirms daemon is running)

- [ ] **Step 3: Verify settings.json has all 4 hooks**

Run: `lossless-claude doctor`
Expected: `PreCompact ✓  SessionStart ✓  SessionEnd ✓  UserPromptSubmit ✓`
