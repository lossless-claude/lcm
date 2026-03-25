# LCM Statusline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native Claude Code statusline to the lcm plugin that shows daemon health (`●`/`◐`/`○`), live activity (compacting/promoting/ingesting/idle), messages ingested, and promoted memory count.

**Architecture:** A new `statusline.mjs` bootstrap (same pattern as `lcm.mjs`) runs a compiled `src/statusline.ts` entry point. On each ~300ms tick, it reads `cwd` from Claude Code's stdin JSON, fires `GET /health` and `POST /status` in parallel to the daemon, and prints one ANSI line to stdout. A shared `src/ansi.ts` module provides color constants. A new `src/daemon/activity.ts` module tracks daemon activity state and is integrated into the compact/promote/ingest routes.

**Tech Stack:** TypeScript (ESM), Node.js built-in `http` (via `fetch`), Vitest for tests, existing `DaemonClient`, `formatNumber()` from `src/stats.ts`.

**Spec:** `.xgh/specs/2026-03-25-lcm-statusline-design.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/ansi.ts` | Shared ANSI color/reset constants |
| Create | `src/daemon/activity.ts` | Global activity state (`idle`/`compacting`/`promoting`/`ingesting`) |
| Create | `src/statusline-render.ts` | Pure function: health + status data → ANSI string |
| Create | `src/statusline.ts` | Entry point: drain stdin, call daemon, write stdout |
| Create | `statusline.mjs` | Bootstrap wrapper (same pattern as `lcm.mjs`) |
| Create | `.claude-plugin/commands/lcm-statusline-setup.md` | Setup slash command |
| Create | `test/statusline-render.test.ts` | Unit tests for renderer |
| Create | `test/daemon/activity.test.ts` | Unit tests for activity state |
| Create | `test/daemon/routes/health.test.ts` | Integration test for `/health` activity field |
| Modify | `src/daemon/server.ts` | Include `activity` in `GET /health` response |
| Modify | `src/daemon/routes/compact.ts` | `setActivity("compacting")` / `setActivity("idle")` |
| Modify | `src/daemon/routes/promote.ts` | `setActivity("promoting")` / `setActivity("idle")` |
| Modify | `src/daemon/routes/ingest.ts` | `setActivity("ingesting")` / `setActivity("idle")` |
| Modify | `src/daemon/client.ts` | Extend `health()` return type with `activity?` and `version?` |
| Modify | `package.json` | Add `statusline.mjs` to `files` array |

---

## Task 1: Shared ANSI constants

**Files:**
- Create: `src/ansi.ts`
- Create: `test/ansi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ansi.test.ts
import { describe, expect, it } from "vitest";
import { GREEN, YELLOW, DIM, RESET } from "../src/ansi.js";

describe("ansi constants", () => {
  it("GREEN starts an ANSI escape sequence", () => {
    expect(GREEN).toMatch(/^\x1b\[/);
  });
  it("RESET ends with m", () => {
    expect(RESET).toBe("\x1b[0m");
  });
  it("DIM is a valid escape", () => {
    expect(DIM).toMatch(/^\x1b\[/);
  });
  it("YELLOW is a valid escape", () => {
    expect(YELLOW).toMatch(/^\x1b\[/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/ansi.test.ts
```
Expected: FAIL — `Cannot find module '../src/ansi.js'`

- [ ] **Step 3: Implement `src/ansi.ts`**

```ts
// src/ansi.ts
export const GREEN  = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const DIM    = "\x1b[2m";
export const RESET  = "\x1b[0m";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/ansi.test.ts
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ansi.ts test/ansi.test.ts
git commit -m "feat: add shared ANSI color constants module"
```

---

## Task 2: Activity state tracker

**Files:**
- Create: `src/daemon/activity.ts`
- Create: `test/daemon/activity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/activity.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { getActivity, setActivity } from "../../src/daemon/activity.js";

describe("activity state", () => {
  beforeEach(() => setActivity("idle"));

  it("defaults to idle", () => {
    expect(getActivity()).toBe("idle");
  });

  it("can be set to compacting", () => {
    setActivity("compacting");
    expect(getActivity()).toBe("compacting");
  });

  it("can be set to promoting", () => {
    setActivity("promoting");
    expect(getActivity()).toBe("promoting");
  });

  it("can be set to ingesting", () => {
    setActivity("ingesting");
    expect(getActivity()).toBe("ingesting");
  });

  it("can be reset to idle", () => {
    setActivity("compacting");
    setActivity("idle");
    expect(getActivity()).toBe("idle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/daemon/activity.test.ts
```
Expected: FAIL — `Cannot find module '../../src/daemon/activity.js'`

- [ ] **Step 3: Implement `src/daemon/activity.ts`**

```ts
// src/daemon/activity.ts
export type ActivityState = "idle" | "compacting" | "promoting" | "ingesting";

let current: ActivityState = "idle";

export function setActivity(state: ActivityState): void {
  current = state;
}

export function getActivity(): ActivityState {
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/daemon/activity.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/activity.ts test/daemon/activity.test.ts
git commit -m "feat: add daemon activity state tracker"
```

---

## Task 3: Integrate activity into daemon routes

**Files:**
- Modify: `src/daemon/routes/compact.ts`
- Modify: `src/daemon/routes/promote.ts`
- Modify: `src/daemon/routes/ingest.ts`

The pattern is the same for all three: import `setActivity`, call it before the work begins, reset to `"idle"` in the `finally` block.

- [ ] **Step 1: Write a failing test for compact activity tracking**

Add to `test/daemon/routes/compact.test.ts` (after existing imports):
```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import * as activity from "../../../src/daemon/activity.js";
import { getActivity, setActivity } from "../../../src/daemon/activity.js";
```

Add a new test inside the existing describe block:
```ts
import * as activityModule from "../../../src/daemon/activity.js";

it("sets activity to compacting then resets to idle after compact route", async () => {
  const calls: string[] = [];
  const spy = vi.spyOn(activityModule, "setActivity").mockImplementation((s) => calls.push(s));
  try {
    // trigger a compact request (use existing daemon/db setup in the file)
    // after the route returns, verify the call sequence
    // This test will be fleshed out with the actual daemon call once the route is modified
    expect(calls[0]).toBe("compacting");
    expect(calls[calls.length - 1]).toBe("idle");
  } finally {
    spy.mockRestore();
  }
});
```

Run to confirm it fails for the right reason (import not found):
```bash
npm test -- test/daemon/routes/compact.test.ts 2>&1 | grep "activity"
```

- [ ] **Step 2: Update `src/daemon/routes/compact.ts`**

Add at the top of the file with the other imports:
```ts
import { setActivity } from "../activity.js";
```

> **Important:** Do NOT create a new try/finally wrapper. The existing try/finally structure is at lines 116–249. Insert two lines only:
> - After `compactingNow.add(session_id)` (line 114): add `setActivity("compacting");`
> - Inside the existing `finally` block at lines 247–249 alongside `compactingNow.delete(session_id)`: add `setActivity("idle");`

The finally block should look like:
```ts
} finally {
  compactingNow.delete(session_id);
  setActivity("idle");
}
```

- [ ] **Step 3: Update `src/daemon/routes/promote.ts`**

Add import at the top of the file:
```ts
import { setActivity } from "../activity.js";
```

Find the main try/finally block in the handler. Add `setActivity("promoting")` before the try and `setActivity("idle")` in the finally.

- [ ] **Step 4: Update `src/daemon/routes/ingest.ts`**

Add import at the top of the file:
```ts
import { setActivity } from "../activity.js";
```

Find the main try/finally block (after request validation). Add `setActivity("ingesting")` before the try and `setActivity("idle")` in the finally.

- [ ] **Step 5: Run all existing route tests to verify nothing broke**

```bash
npm test -- test/daemon/routes/compact.test.ts test/daemon/routes/promote.test.ts test/daemon/routes/ingest.test.ts
```
Expected: all existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/routes/compact.ts src/daemon/routes/promote.ts src/daemon/routes/ingest.ts test/daemon/routes/compact.test.ts
git commit -m "feat: track activity state in compact/promote/ingest routes"
```

---

## Task 4: Expose activity in `GET /health`

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/daemon/client.ts`
- Create: `test/daemon/routes/health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/routes/health.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { setActivity } from "../../../src/daemon/activity.js";

describe("GET /health activity field", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = undefined; }
    setActivity("idle");
  });

  it("returns activity: idle by default", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
    const data = await res.json() as any;
    expect(data.activity).toBe("idle");
  });

  it("reflects current activity state", async () => {
    setActivity("compacting");
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
    const data = await res.json() as any;
    expect(data.activity).toBe("compacting");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/daemon/routes/health.test.ts
```
Expected: FAIL — `data.activity` is `undefined`

- [ ] **Step 3: Update `src/daemon/server.ts` — add `activity` to `/health`**

**First**, add the import at the top of `src/daemon/server.ts` alongside the other imports:
```ts
import { getActivity } from "./activity.js";
```

**Then**, find the existing health route (around line 66) and replace it:
```ts
// Before:
routes.set("GET /health", async (_req, res) =>
  sendJson(res, 200, { status: "ok", version: PKG_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000) }));

// After:
routes.set("GET /health", async (_req, res) =>
  sendJson(res, 200, { status: "ok", version: PKG_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000), activity: getActivity() }));
```

- [ ] **Step 4: Update `src/daemon/client.ts` — extend `health()` return type**

```ts
async health(): Promise<{ status: string; version?: string; uptime: number; activity?: string } | null> {
  try {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.ok ? (await res.json() as { status: string; version?: string; uptime: number; activity?: string }) : null;
  } catch { return null; }
}
```

- [ ] **Step 5: Run health tests**

```bash
npm test -- test/daemon/routes/health.test.ts test/daemon/client.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.ts src/daemon/client.ts test/daemon/routes/health.test.ts
git commit -m "feat: expose activity state in GET /health response"
```

---

## Task 5: Statusline renderer (pure function)

**Files:**
- Create: `src/statusline-render.ts`
- Create: `test/statusline-render.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/statusline-render.test.ts
import { describe, expect, it } from "vitest";
import { renderStatusline } from "../src/statusline-render.js";

describe("renderStatusline", () => {
  it("renders dead state when health is null", () => {
    const result = renderStatusline(null, null);
    expect(result).toContain("○");
    expect(result).toContain("dead");
    // No stats shown when dead
    expect(result).not.toContain("msgs");
  });

  it("renders idle state with stats", () => {
    const health = { status: "ok", activity: "idle", uptime: 100, version: "0.5.0" };
    const status = { project: { messageCount: 234, promotedCount: 12, summaryCount: 5, lastIngest: null, lastCompact: null, lastPromote: null } };
    const result = renderStatusline(health, status);
    expect(result).toContain("●");
    expect(result).toContain("idle");
    expect(result).toContain("234 msgs");
    expect(result).toContain("12 promoted");
  });

  it("renders compacting activity", () => {
    const health = { status: "ok", activity: "compacting", uptime: 100, version: "0.5.0" };
    const status = { project: { messageCount: 50, promotedCount: 3, summaryCount: 2, lastIngest: null, lastCompact: null, lastPromote: null } };
    const result = renderStatusline(health, status);
    expect(result).toContain("◐");
    expect(result).toContain("compacting");
  });

  it("uses formatNumber for large counts", () => {
    const health = { status: "ok", activity: "idle", uptime: 100, version: "0.5.0" };
    const status = { project: { messageCount: 1500, promotedCount: 0, summaryCount: 0, lastIngest: null, lastCompact: null, lastPromote: null } };
    const result = renderStatusline(health, status);
    expect(result).toContain("1.5k msgs");
  });

  it("renders separator between segments", () => {
    const health = { status: "ok", activity: "idle", uptime: 100, version: "0.5.0" };
    const status = { project: { messageCount: 10, promotedCount: 2, summaryCount: 0, lastIngest: null, lastCompact: null, lastPromote: null } };
    const result = renderStatusline(health, status);
    expect(result).toContain("│");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/statusline-render.test.ts
```
Expected: FAIL — `Cannot find module '../src/statusline-render.js'`

- [ ] **Step 3: Implement `src/statusline-render.ts`**

```ts
// src/statusline-render.ts
import { formatNumber } from "./stats.js";
import { GREEN, YELLOW, DIM, RESET } from "./ansi.js";

export type HealthData = {
  status: string;
  activity?: string;
  uptime?: number;
  version?: string;
} | null;

export type StatusData = {
  project: {
    messageCount: number;
    promotedCount: number;
    summaryCount: number;
    lastIngest: string | null;
    lastCompact: string | null;
    lastPromote: string | null;
  };
} | null;

export function renderStatusline(health: HealthData, status: StatusData): string {
  if (!health) {
    return `${DIM}○ dead${RESET}`;
  }

  const activity = health.activity ?? "idle";
  const isActive = activity !== "idle";
  const dot = isActive ? `${YELLOW}◐${RESET}` : `${GREEN}●${RESET}`;
  const label = isActive
    ? `${YELLOW}${activity}${RESET}`
    : `${GREEN}idle${RESET}`;

  if (!status) {
    return `${dot} ${label}`;
  }

  const msgs = `${DIM}${formatNumber(status.project.messageCount)} msgs${RESET}`;
  const promoted = `${DIM}${formatNumber(status.project.promotedCount)} promoted${RESET}`;
  const sep = `${DIM}│${RESET}`;

  return `${dot} ${label} ${sep} ${msgs} ${sep} ${promoted}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/statusline-render.test.ts
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/statusline-render.ts test/statusline-render.test.ts
git commit -m "feat: add statusline renderer (pure function)"
```

---

## Task 6: Statusline entry point

**Files:**
- Create: `src/statusline.ts`

No unit tests for this file — it's I/O-only glue. The integration is verified manually in Task 8.

- [ ] **Step 1: Implement `src/statusline.ts`**

```ts
// src/statusline.ts
import { loadDaemonConfig } from "./daemon/config.js";
import { DaemonClient } from "./daemon/client.js";
import { renderStatusline, type HealthData, type StatusData } from "./statusline-render.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "{}";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  // Must drain stdin — Claude Code API requirement
  const raw = await readStdin();
  let cwd: string = process.cwd();
  try {
    const stdin = JSON.parse(raw) as { cwd?: string };
    if (stdin.cwd) cwd = stdin.cwd;
  } catch { /* ignore parse errors */ }

  const config = loadDaemonConfig("/x");
  const client = new DaemonClient(`http://127.0.0.1:${config.daemon.port}`);

  let health: HealthData = null;
  let status: StatusData = null;

  try {
    [health, status] = await Promise.all([
      client.health(),
      client.post<StatusData>("/status", { cwd }).catch(() => null),
    ]);
  } catch { /* daemon unreachable — render dead state */ }

  process.stdout.write(renderStatusline(health, status) + "\n");
}

void main();
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/statusline.ts
git commit -m "feat: add statusline entry point"
```

---

## Task 7: Bootstrap wrapper and package.json

**Files:**
- Create: `statusline.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `statusline.mjs`** (copy pattern from `lcm.mjs`, just change the final import target)

```js
#!/usr/bin/env node
// Statusline bootstrap for Claude Code native status bar API.
// Claude Code invokes this every ~300ms and reads one ANSI line from stdout.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, "node_modules"))) {
  try {
    execSync("npm install --silent", { cwd: __dirname, stdio: "pipe", timeout: 60000 });
  } catch {}
}

if (!existsSync(join(__dirname, "dist"))) {
  try {
    execSync("npm run build --silent", { cwd: __dirname, stdio: "pipe", timeout: 120000 });
  } catch {}
}

const entry = pathToFileURL(join(__dirname, "dist", "src", "statusline.js")).href;
try {
  await import(entry);
} catch {
  // Never crash the terminal status bar — output nothing on failure
  process.exit(0);
}
```

- [ ] **Step 2: Add `statusline.mjs` to `package.json` files array**

In `package.json`, change:
```json
"files": [
  "dist/",
  "mcp.mjs",
  "lcm.mjs",
  ".claude-plugin/",
  "docs/",
  "README.md",
  "LICENSE"
],
```
To:
```json
"files": [
  "dist/",
  "mcp.mjs",
  "lcm.mjs",
  "statusline.mjs",
  ".claude-plugin/",
  "docs/",
  "README.md",
  "LICENSE"
],
```

- [ ] **Step 3: Build and smoke-test the bootstrap**

```bash
npm run build && echo '{"cwd":"'$(pwd)'"}' | node statusline.mjs
```
Expected: one line of output like `● idle │ 0 msgs │ 0 promoted` (or `○ dead` if daemon not running — both are correct)

- [ ] **Step 4: Run the full test suite to confirm nothing regressed**

```bash
npm test
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add statusline.mjs package.json
git commit -m "feat: add statusline.mjs bootstrap and include in npm files"
```

---

## Task 8: Setup slash command

**Files:**
- Create: `.claude-plugin/commands/lcm-statusline-setup.md`

This command writes the `statusLine` entry into the user's `~/.claude/settings.json`. Follow the pattern of existing setup commands in the repo.

- [ ] **Step 1: Check an existing command for frontmatter format**

```bash
head -10 .claude-plugin/commands/lcm-status.md
```

- [ ] **Step 2: Create `.claude-plugin/commands/lcm-statusline-setup.md`**

```markdown
---
name: lcm-statusline-setup
description: Configure the lcm statusline in Claude Code settings
user_invocable: true
---

Configure the lcm statusline so Claude Code displays daemon health and memory stats in your terminal status bar.

This command adds a `statusLine` entry to `~/.claude/settings.json` pointing to `statusline.mjs` in the plugin root.

Steps:
1. Find `${CLAUDE_PLUGIN_ROOT}` (the directory where lcm is installed)
2. Read `~/.claude/settings.json` (create it if it doesn't exist)
3. Add or replace the `statusLine` key:

```json
{
  "statusLine": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/statusline.mjs"]
  }
}
```

4. Write the file back
5. Tell the user to restart Claude Code to activate the statusline

Use `node` as the command — no global binary required. The `statusline.mjs` bootstrap handles auto-build if needed.
```

- [ ] **Step 3: Verify command is discoverable**

```bash
ls .claude-plugin/commands/ | grep statusline
```
Expected: `lcm-statusline-setup.md`

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/commands/lcm-statusline-setup.md
git commit -m "feat: add /lcm-statusline-setup command"
```

---

## Task 9: Final build verification and PR

- [ ] **Step 1: Run full test suite**

```bash
npm test
```
Expected: all tests pass (no regressions)

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```
Expected: no errors

- [ ] **Step 3: Verify npm pack includes statusline.mjs**

```bash
npm pack --dry-run 2>&1 | grep statusline
```
Expected: `statusline.mjs` appears in the file list

- [ ] **Step 4: Push and create PR targeting `develop`**

```bash
git push -u origin <branch-name>
gh pr create --repo lossless-claude/lcm --base develop --title "feat: lcm statusline for Claude Code status bar" --body "..."
```

---

## Quick Reference

| What | Command |
|------|---------|
| Run all tests | `npm test` |
| Run one test file | `npm test -- test/path/to/file.test.ts` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Smoke-test statusline | `echo '{"cwd":"'$(pwd)'"}' \| node statusline.mjs` |
