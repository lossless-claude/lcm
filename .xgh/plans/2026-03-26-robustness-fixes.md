# lcm Robustness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three robustness gaps: broken `lcm status` (missing auth token), missing `lcm daemon stop`, and silent plugin/daemon version skew.

**Architecture:** Fix 1 and Fix 2 extract command logic into `src/commands/` for testability, then wire thin callers in `bin/lcm.ts`. Fix 3 adds a best-effort version-stamp check directly in `lcm.mjs`. All three fixes are independent commits.

**Tech Stack:** TypeScript, Node.js, vitest, commander, `node:http`, `node:fs`, `node:child_process`

---

## Task 1: Extract and fix `lcm status` auth

**Files:**
- Create: `src/commands/status.ts`
- Modify: `bin/lcm.ts` (status action, ~lines 344–430)
- Create: `test/commands/status.test.ts`

---

- [ ] **Step 1: Write the failing tests**

Create `test/commands/status.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must be hoisted before any import of the module under test
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn() };
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { readFileSync } from "node:fs";
import { handleStatus } from "../../src/commands/status.js";

const LC_DIR = "/home/user/.lossless-claude";
const PORT = 3737;

describe("handleStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Authorization header when token file exists", async () => {
    vi.mocked(readFileSync).mockReturnValue("test-token-abc\n" as any);
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // health
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          daemon: { version: "0.7.0", uptime: 10, port: 3737 },
          project: { messageCount: 5, summaryCount: 1, promotedCount: 2 },
        }),
      });

    await handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR);

    const [_url, fetchOpts] = mockFetch.mock.calls[1];
    expect((fetchOpts.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-token-abc",
    );
  });

  it("does not crash when token file is missing (ENOENT)", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(readFileSync).mockImplementation(() => { throw err; });
    mockFetch.mockResolvedValueOnce({ ok: false }); // health → daemon down

    await expect(
      handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR),
    ).resolves.toBeUndefined();
  });

  it("prints token-stale message on 401 without crashing", async () => {
    vi.mocked(readFileSync).mockReturnValue("old-token" as any);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // health ok
      .mockResolvedValueOnce({ ok: false, status: 401 }); // status → 401

    await handleStatus({ json: false, provider: "claude-process" }, PORT, LC_DIR);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("token stale"));
    spy.mockRestore();
  });

  it("--json outputs valid JSON with daemon and project fields", async () => {
    vi.mocked(readFileSync).mockReturnValue("tok" as any);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          daemon: { version: "0.7.0", uptime: 10, port: 3737 },
          project: { messageCount: 5, summaryCount: 1, promotedCount: 2 },
        }),
      });

    await handleStatus({ json: true, provider: "claude-process" }, PORT, LC_DIR);

    const written = (writeSpy.mock.calls[0][0] as string);
    const parsed = JSON.parse(written);
    expect(parsed.daemon.version).toBe("0.7.0");
    expect(parsed.project.messageCount).toBe(5);
    writeSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
cd /Users/pedro/Developer/lossless-claude
npx vitest run test/commands/status.test.ts
```

Expected: 4 failures — `handleStatus` does not exist yet.

- [ ] **Step 3: Create `src/commands/status.ts`**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type StatusOptions = { json: boolean; provider: string };

export async function handleStatus(
  opts: StatusOptions,
  port: number,
  lcDir: string,
): Promise<void> {
  // Read auth token — best-effort, never throws
  let daemonToken: string | null = null;
  try {
    daemonToken = readFileSync(join(lcDir, "daemon.token"), "utf-8").trim();
  } catch {
    // ENOENT or unreadable — proceed without auth
  }

  let daemonStatus = "down";
  let statusData: Record<string, unknown> | null = null;

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    if (healthRes.ok) daemonStatus = "up";

    if (daemonStatus === "up") {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (daemonToken) headers["Authorization"] = `Bearer ${daemonToken}`;

      const statusRes = await fetch(`http://127.0.0.1:${port}/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cwd: process.cwd() }),
      });
      if (statusRes.ok) {
        statusData = await statusRes.json() as Record<string, unknown>;
      } else if (statusRes.status === 401) {
        daemonStatus = "token-stale";
      }
    }
  } catch { /* daemon unreachable */ }

  if (opts.json) {
    const result = {
      daemon: daemonStatus === "up" && statusData
        ? (statusData as any).daemon
        : { status: daemonStatus },
      project: statusData ? (statusData as any).project : null,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (daemonStatus === "token-stale") {
    console.log("daemon: token stale — restart daemon with `lcm daemon start --detach`");
    return;
  }

  if (statusData) {
    const d = (statusData as any).daemon;
    const p = (statusData as any).project;
    console.log(`Daemon: up`);
    console.log(`  Version: ${d.version}`);
    console.log(`  Uptime: ${d.uptime}s`);
    console.log(`  Port: ${d.port}`);
    console.log(`  Provider: ${opts.provider}`);
    console.log();
    console.log("Project:");
    console.log(`  Messages: ${p.messageCount}`);
    console.log(`  Summaries: ${p.summaryCount}`);
    console.log(`  Promoted: ${p.promotedCount}`);
    if (p.lastIngest) console.log(`  Last Ingest: ${p.lastIngest}`);
    if (p.lastCompact) console.log(`  Last Compact: ${p.lastCompact}`);
    if (p.lastPromote) console.log(`  Last Promote: ${p.lastPromote}`);
  } else {
    console.log(`daemon: ${daemonStatus} · provider: ${opts.provider}`);
  }
}
```

- [ ] **Step 4: Run tests to confirm GREEN**

```bash
npx vitest run test/commands/status.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Wire into `bin/lcm.ts` — replace inline status action**

Find the `.command("status")` action in `bin/lcm.ts` (around line 344). Replace the full action body with:

```typescript
.action(async (opts) => {
  if (opts.help) {
    const { printHelp } = await import("../src/cli-help.js");
    printHelp("status"); exit(0);
  }
  const { loadDaemonConfig } = await import("../src/daemon/config.js");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const { handleStatus } = await import("../src/commands/status.js");
  const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
  const port = config.daemon?.port ?? 3737;
  const provider = config.llm?.provider ?? "unknown";
  const providerDisplay = provider === "auto"
    ? "auto (Claude->claude-process, Codex->codex-process)"
    : provider;
  await handleStatus(
    { json: opts.json ?? false, provider: providerDisplay },
    port,
    join(homedir(), ".lossless-claude"),
  );
});
```

- [ ] **Step 6: Build and smoke-test**

```bash
npm run build
node dist/bin/lcm.js status
node dist/bin/lcm.js status --json
```

Expected: `status` shows daemon version, uptime, port, provider, and project stats. `status --json` outputs a non-empty JSON object with `daemon.version` and `project.messageCount`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/status.ts test/commands/status.test.ts bin/lcm.ts
git commit -m "fix: add auth token to lcm status daemon request"
```

---

## Task 2: Add `lcm daemon stop`

**Files:**
- Create: `src/commands/daemon-stop.ts`
- Modify: `bin/lcm.ts` (add stop subcommand after `daemonCmd.command("start")`)
- Create: `test/commands/daemon-stop.test.ts`

---

- [ ] **Step 1: Write the failing tests**

Create `test/commands/daemon-stop.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleDaemonStop, type DaemonStopDeps } from "../../src/commands/daemon-stop.js";
import { join } from "node:path";

const LC_DIR = "/home/user/.lossless-claude";
const PID_FILE = join(LC_DIR, "daemon.pid");

function makeDeps(overrides: Partial<DaemonStopDeps> = {}): DaemonStopDeps {
  return {
    existsSync: () => true,
    readFileSync: () => "12345" as any,
    unlinkSync: vi.fn(),
    spawnSync: () => ({ stdout: "node", status: 0 } as any),
    kill: vi.fn(),
    sleep: async () => {},
    ...overrides,
  };
}

describe("handleDaemonStop", () => {
  it("returns 'not running' when PID file is absent", async () => {
    const result = await handleDaemonStop(LC_DIR, makeDeps({ existsSync: () => false }));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("not running");
  });

  it("returns 'stale pid file' and unlinks when process is dead (ESRCH)", async () => {
    const unlink = vi.fn();
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === 0) { const e = Object.assign(new Error(), { code: "ESRCH" }); throw e; }
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("stale pid file");
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });

  it("sends SIGTERM and removes PID file after process stops", async () => {
    const unlink = vi.fn();
    let pollCount = 0;
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === 0) {
        pollCount++;
        if (pollCount > 1) { throw Object.assign(new Error(), { code: "ESRCH" }); }
      }
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
    expect(result.exitCode).toBe(0);
    expect(result.message).toBe("lcm daemon stopped");
    // PID file removed AFTER process confirmed dead
    expect(unlink).toHaveBeenLastCalledWith(PID_FILE);
  });

  it("aborts with exit 1 when PID belongs to a non-lcm process", async () => {
    const kill = vi.fn(); // kill(0) always succeeds = process alive
    const result = await handleDaemonStop(
      LC_DIR,
      makeDeps({
        spawnSync: () => ({ stdout: "postgres", status: 0 } as any),
        kill,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("different process");
    expect(kill).not.toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("escalates to SIGKILL when process does not stop within poll limit", async () => {
    const unlink = vi.fn();
    let sigkillSent = false;
    const kill = vi.fn().mockImplementation((_pid: number, sig: unknown) => {
      if (sig === "SIGKILL") sigkillSent = true;
      if (sig === 0 && !sigkillSent) return; // still alive
      if (sig === 0 && sigkillSent) throw Object.assign(new Error(), { code: "ESRCH" });
    });
    const result = await handleDaemonStop(LC_DIR, makeDeps({ unlinkSync: unlink, kill }));
    expect(kill).toHaveBeenCalledWith(12345, "SIGKILL");
    expect(result.exitCode).toBe(0);
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });

  it("returns exit 0 with 'corrupt pid file' on unparseable content", async () => {
    const unlink = vi.fn();
    const result = await handleDaemonStop(
      LC_DIR,
      makeDeps({ readFileSync: () => "not-a-number" as any, unlinkSync: unlink }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("corrupt");
    expect(unlink).toHaveBeenCalledWith(PID_FILE);
  });
});
```

- [ ] **Step 2: Run to confirm RED**

```bash
npx vitest run test/commands/daemon-stop.test.ts
```

Expected: 6 failures — `handleDaemonStop` does not exist yet.

- [ ] **Step 3: Create `src/commands/daemon-stop.ts`**

```typescript
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export type DaemonStopDeps = {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: string) => string;
  unlinkSync?: (path: string) => void;
  spawnSync?: typeof nodeSpawnSync;
  kill?: (pid: number, signal: number | string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type DaemonStopResult = { exitCode: number; message: string };

export async function handleDaemonStop(
  lcDir: string,
  deps: DaemonStopDeps = {},
): Promise<DaemonStopResult> {
  const fsExists = deps.existsSync ?? existsSync;
  const fsRead = deps.readFileSync ?? ((p: string, enc: string) => readFileSync(p, enc as BufferEncoding) as string);
  const fsUnlink = deps.unlinkSync ?? unlinkSync;
  const spawnFn = deps.spawnSync ?? nodeSpawnSync;
  const killFn = deps.kill ?? ((pid, sig) => process.kill(pid, sig as NodeJS.Signals));
  const sleepFn = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const pidFilePath = join(lcDir, "daemon.pid");

  if (!fsExists(pidFilePath)) {
    return { exitCode: 0, message: "lcm daemon is not running" };
  }

  let pid: number;
  try {
    pid = parseInt(fsRead(pidFilePath, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) throw new Error("invalid");
  } catch {
    try { fsUnlink(pidFilePath); } catch { /* ignore */ }
    return { exitCode: 0, message: "lcm daemon is not running (corrupt pid file)" };
  }

  // Check liveness
  try {
    killFn(pid, 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      try { fsUnlink(pidFilePath); } catch { /* ignore */ }
      return { exitCode: 0, message: "lcm daemon is not running (stale pid file)" };
    }
    // EPERM: process exists but we lack permission — proceed
  }

  // Validate process identity before signaling
  try {
    const ps = spawnFn("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf-8" });
    const comm = (ps.stdout as string)?.trim() ?? "";
    if (comm && !comm.includes("node") && !comm.includes("lcm")) {
      return {
        exitCode: 1,
        message: `lcm: PID ${pid} is a different process (${comm}) — aborting to prevent accidental SIGTERM`,
      };
    }
  } catch { /* ps unavailable — proceed */ }

  // Send SIGTERM
  try {
    killFn(pid, "SIGTERM");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      try { fsUnlink(pidFilePath); } catch { /* ignore */ }
      return { exitCode: 0, message: "lcm daemon is not running (stale pid file)" };
    }
    return { exitCode: 1, message: `lcm: failed to send SIGTERM to PID ${pid}` };
  }

  // Poll kill -0 for up to 25 × 200ms = 5s
  let stopped = false;
  for (let i = 0; i < 25; i++) {
    await sleepFn(200);
    try {
      killFn(pid, 0);
    } catch {
      stopped = true;
      break;
    }
  }

  // Escalate to SIGKILL
  if (!stopped) {
    try {
      killFn(pid, "SIGKILL");
      await sleepFn(500);
    } catch { /* already dead */ }
  }

  // PID file removal is always the last step
  try { fsUnlink(pidFilePath); } catch { /* ignore */ }

  return {
    exitCode: 0,
    message: stopped ? "lcm daemon stopped" : "lcm daemon: sent SIGKILL, assuming stopped",
  };
}
```

- [ ] **Step 4: Run tests to confirm GREEN**

```bash
npx vitest run test/commands/daemon-stop.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Wire into `bin/lcm.ts`**

Find `daemonCmd.command("start")` block (around line 55). Add the `stop` subcommand immediately after the `start` block closes, before `daemonCmd.action(...)`:

```typescript
  daemonCmd.command("stop")
    .description("Stop the context daemon")
    .helpOption(false)
    .option("-h, --help", "Show help")
    .action(async (opts) => {
      if (opts.help) { await withCustomHelp(daemonCmd, "daemon"); return; }
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { handleDaemonStop } = await import("../src/commands/daemon-stop.js");
      const lcDir = join(homedir(), ".lossless-claude");
      const { exitCode, message } = await handleDaemonStop(lcDir);
      console.log(message);
      exit(exitCode);
    });
```

- [ ] **Step 6: Build and smoke-test**

```bash
npm run build
node dist/bin/lcm.js daemon stop
```

Expected: `lcm daemon stopped` (daemon was running) or `lcm daemon is not running`.

Then verify restart works cleanly after stop:
```bash
node dist/bin/lcm.js daemon start --detach && sleep 2 && node dist/bin/lcm.js daemon stop
```

- [ ] **Step 7: Commit**

```bash
git add src/commands/daemon-stop.ts test/commands/daemon-stop.test.ts bin/lcm.ts
git commit -m "fix: add lcm daemon stop subcommand"
```

---

## Task 3: Version-stamp warning in `lcm.mjs`

**Files:**
- Modify: `lcm.mjs`

---

- [ ] **Step 1: Read the current end of `lcm.mjs`**

The last meaningful lines of `lcm.mjs` currently are:

```javascript
// Delegate to the compiled CLI — process.argv passes through unchanged
const cliModule = join(__dirname, "dist", "bin", "lcm.js");
await import(pathToFileURL(cliModule).href);
```

- [ ] **Step 2: Add version-stamp check before the delegation**

Replace those last 3 lines with:

```javascript
// Version-stamp check: warn if plugin cache version ≠ running daemon version.
// Best-effort only — never blocks or throws. Uses 300ms timeout to stay non-disruptive.
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pluginVersion = require("./package.json").version;

  const daemonHealth = await new Promise((resolve) => {
    import("node:http").then(({ default: http }) => {
      const req = http.get(
        "http://127.0.0.1:3737/health",
        { timeout: 300 },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
    }).catch(() => resolve(null));
  });

  if (daemonHealth?.version && daemonHealth.version !== pluginVersion) {
    process.stderr.write(
      `[lcm] version mismatch: plugin=${pluginVersion} daemon=${daemonHealth.version}` +
      ` — run \`lcm install\` to update\n`,
    );
  }
} catch {
  // Never block hook execution on version check failure
}

// Delegate to the compiled CLI — process.argv passes through unchanged
const cliModule = join(__dirname, "dist", "bin", "lcm.js");
await import(pathToFileURL(cliModule).href);
```

- [ ] **Step 3: Smoke-test the warning**

Start a daemon from the repo (version will be `0.7.0`), then invoke `lcm.mjs` with a spoofed plugin version by temporarily editing `package.json` version to `0.6.0`:

```bash
# In a temp copy — do NOT commit this change
node lcm.mjs --version 2>&1
# Should see: [lcm] version mismatch: plugin=0.6.0 daemon=0.7.0 — run `lcm install` to update
# Then revert package.json
```

- [ ] **Step 4: Smoke-test the no-warning path (matching versions)**

```bash
node lcm.mjs --version 2>&1
# Should see NO [lcm] version mismatch line — versions match
```

- [ ] **Step 5: Commit**

```bash
git add lcm.mjs
git commit -m "fix: warn on plugin/daemon version mismatch in lcm.mjs"
```

---

## Task 4: Open PR

- [ ] **Step 1: Push and open PR targeting `develop`**

```bash
git push origin fix/daemon-self-healing
gh pr create \
  --base develop \
  --title "fix: lcm v0.7.1 robustness — status auth, daemon stop, version-stamp warning" \
  --body "$(cat <<'EOF'
## Summary

- **Fix status auth**: `lcm status` was missing `Authorization: Bearer` header on `/status` POST → always received 401 → terse output and broken `--json`. Reads token from `~/.lossless-claude/daemon.token` with graceful ENOENT handling.
- **daemon stop**: Adds `lcm daemon stop` subcommand. Uses `kill -0` polling (not HTTP health) for reliable process-exit detection, escalates to SIGKILL after 5s, validates PID identity before signaling, removes PID file last.
- **Version-stamp warning**: `lcm.mjs` now checks plugin cache version against running daemon version and writes a one-line warning to stderr on mismatch. Best-effort, 300ms timeout, never blocks.

## Test plan
- [ ] `npx vitest run test/commands/status.test.ts` — 4 tests pass
- [ ] `npx vitest run test/commands/daemon-stop.test.ts` — 6 tests pass
- [ ] `lcm status` shows full project stats
- [ ] `lcm status --json` returns non-empty object
- [ ] `lcm daemon stop` stops daemon cleanly; second call says "not running"
- [ ] `lcm daemon stop` on stale PID removes file and exits 0

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
