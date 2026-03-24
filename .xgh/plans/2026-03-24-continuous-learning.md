# Continuous Mid-Session Learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable lcm to capture insights mid-session (via `lcm_store` instruction + Stop hook rolling ingest), always compact and promote at session end, and bootstrap automatically on first hook fire.

**Architecture:** Three capture paths: (1) CLAUDE.md-style instruction injected by UserPromptSubmit tells Claude to call existing `lcm_store` for 7 insight categories; (2) Stop hook with stat-based throttling sends `transcript_path` to existing `/ingest` endpoint every 60s; (3) SessionEnd always compacts + promotes, records completion in SQLite manifest. A shared `ensureCore()` function handles lazy bootstrap and fixes #94 duplicate hooks.

**Tech Stack:** TypeScript, Commander.js, vitest, node:http, node:fs, SQLite (node:sqlite)

**Spec:** `.xgh/specs/2026-03-24-continuous-learning-design.md`

---

### Task 1: Add `hooks` config section to DaemonConfig

**Files:**
- Modify: `src/daemon/config.ts:10-42`
- Test: `test/daemon/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In test/daemon/config.test.ts — add to existing describe block
it("loads hooks config with defaults", () => {
  const config = loadDaemonConfig("/nonexistent");
  expect(config.hooks).toEqual({
    snapshotIntervalSec: 60,
    disableAutoCompact: false,
  });
});

it("merges user-provided hooks config", () => {
  const config = loadDaemonConfig("/nonexistent", {
    hooks: { snapshotIntervalSec: 30 },
  });
  expect(config.hooks.snapshotIntervalSec).toBe(30);
  expect(config.hooks.disableAutoCompact).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/config.test.ts --reporter=verbose`
Expected: FAIL — `config.hooks` is undefined

- [ ] **Step 3: Add hooks section to DaemonConfig type and DEFAULTS**

In `src/daemon/config.ts`, add to the `DaemonConfig` type (after line 20):

```typescript
hooks: { snapshotIntervalSec: number; disableAutoCompact: boolean };
```

In the `DEFAULTS` constant (after the `security` field):

```typescript
hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/config.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/config.ts test/daemon/config.test.ts
git commit -m "feat(config): add hooks section with snapshotIntervalSec and disableAutoCompact"
```

---

### Task 2: Add `session_ingest_log` migration

**Files:**
- Modify: `src/db/migration.ts:519-534` (after the promoted table section)
- Test: `test/migration.test.ts` (note: lives at repo root, not `test/db/`)

- [ ] **Step 1: Write the failing test**

```typescript
// In test/migration.test.ts — add to existing describe block
it("creates session_ingest_log table", () => {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  const info = db.prepare("PRAGMA table_info(session_ingest_log)").all() as Array<{ name: string }>;
  const columns = info.map((r) => r.name);
  expect(columns).toContain("session_id");
  expect(columns).toContain("completed_at");
  expect(columns).toContain("message_count");
  db.close();
});

it("session_ingest_log is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  runLcmMigrations(db, { fts5Available: false }); // second run
  const info = db.prepare("PRAGMA table_info(session_ingest_log)").all() as Array<{ name: string }>;
  expect(info.length).toBeGreaterThan(0);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migration.test.ts --reporter=verbose`
Expected: FAIL — table does not exist

- [ ] **Step 3: Add CREATE TABLE to runLcmMigrations**

In `src/db/migration.ts`, after the `promoted` FTS5 section (around line 534), add:

```typescript
  // Session ingest log — tracks which sessions are fully ingested
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_ingest_log (
      session_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0
    );
  `);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migration.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/migration.ts test/migration.test.ts
git commit -m "feat(db): add session_ingest_log table for ingestion tracking"
```

---

### Task 3: Extract `ensureCore()` from `install()`

**Files:**
- Modify: `installer/install.ts:189-257`
- Create: `src/bootstrap.ts`
- Test: `test/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test for `ensureCore()`**

```typescript
// test/bootstrap.test.ts
import { describe, it, expect, vi } from "vitest";
import type { EnsureCoreDeps } from "../src/bootstrap.js";

function makeDeps(overrides: Partial<EnsureCoreDeps> = {}): EnsureCoreDeps {
  return {
    configPath: "/tmp/test-config.json",
    settingsPath: "/tmp/test-settings.json",
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    ...overrides,
  };
}

describe("ensureCore", () => {
  it("creates config.json with defaults when missing", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      deps.configPath,
      expect.stringContaining('"version"'),
    );
  });

  it("skips config.json creation when it already exists", async () => {
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: 1 })),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    // writeFileSync called only for settings.json (mergeClaudeSettings), not config.json
    const configWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: [string]) => path === deps.configPath);
    expect(configWrites.length).toBe(0);
  });

  it("calls mergeClaudeSettings to clean stale hooks", async () => {
    const settingsWithDupes = JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
      },
    });
    const deps = makeDeps({
      existsSync: vi.fn().mockImplementation((p: string) => p.endsWith("settings.json")),
      readFileSync: vi.fn().mockReturnValue(settingsWithDupes),
    });
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    const settingsWrites = (deps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: [string]) => path === deps.settingsPath);
    expect(settingsWrites.length).toBe(1);
    const written = JSON.parse(settingsWrites[0][1]);
    // Duplicate PreCompact hook should be cleaned by mergeClaudeSettings
    expect(written.hooks?.PreCompact).toBeUndefined();
  });

  it("starts daemon if not running", async () => {
    const deps = makeDeps();
    const { ensureCore } = await import("../src/bootstrap.js");
    await ensureCore(deps);
    expect(deps.ensureDaemon).toHaveBeenCalled();
  });
});

describe("ensureBootstrapped", () => {
  it("skips ensureCore when flag file exists", async () => {
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(true),
      writeFlag: vi.fn(),
    });
    expect(coreDeps.ensureDaemon).not.toHaveBeenCalled();
  });

  it("runs ensureCore and writes flag when flag file missing", async () => {
    const writeFlag = vi.fn();
    const coreDeps = makeDeps();
    const { ensureBootstrapped } = await import("../src/bootstrap.js");
    await ensureBootstrapped("test-session", {
      ...coreDeps,
      flagExists: vi.fn().mockReturnValue(false),
      writeFlag,
    });
    expect(coreDeps.ensureDaemon).toHaveBeenCalled();
    expect(writeFlag).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bootstrap.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `ensureCore()` and `ensureBootstrapped()`**

Create `src/bootstrap.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { mergeClaudeSettings } from "../installer/install.js";
import { loadDaemonConfig } from "./daemon/config.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: join(homedir(), ".lossless-claude", "config.json"),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<void> {
  // 1. Create config.json with defaults if missing
  if (!deps.existsSync(deps.configPath)) {
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    const defaults = loadDaemonConfig("/nonexistent");
    deps.writeFileSync(deps.configPath, JSON.stringify(defaults, null, 2));
  }

  // 2. Clean stale/duplicate hooks from settings.json (fixes #94)
  if (deps.existsSync(deps.settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
      const merged = mergeClaudeSettings(existing);
      deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
      deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
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

export function ensureBootstrapped(
  sessionId: string,
  deps: BootstrapDeps = defaultBootstrapDeps(),
): Promise<void> {
  const flagPath = join(tmpdir(), `lcm-bootstrapped-${sessionId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return Promise.resolve();
  } catch {}

  return ensureCore(deps).then(() => {
    try { deps.writeFlag(flagPath); } catch {}
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bootstrap.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Wire `ensureCore()` into `install()`**

In `installer/install.ts`, import `ensureCore` and replace the config creation + settings merge + daemon start sections with a call to `ensureCore()`, keeping the interactive parts (pickSummarizer, commands copy, doctor) in `install()`.

- [ ] **Step 6: Run full installer tests**

Run: `npx vitest run test/installer/ --reporter=verbose`
Expected: PASS (existing behavior preserved)

- [ ] **Step 7: Commit**

```bash
git add src/bootstrap.ts test/bootstrap.test.ts installer/install.ts
git commit -m "feat: extract ensureCore() from install() for lazy bootstrap (#94)"
```

---

### Task 4: Add `session-snapshot` hook handler

**Files:**
- Create: `src/hooks/session-snapshot.ts`
- Modify: `src/hooks/dispatch.ts:2-44`
- Test: `test/hooks/session-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/hooks/session-snapshot.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotDeps } from "../../src/hooks/session-snapshot.js";

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    statSync: vi.fn().mockReturnValue(null),
    writeFileSync: vi.fn(),
    snapshotIntervalSec: 60,
    post: vi.fn().mockResolvedValue({ ingested: 5 }),
    ...overrides,
  };
}

describe("handleSessionSnapshot", () => {
  it("ingests when no cursor file exists", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: "abc-123",
      cwd: "/tmp/test",
      transcript_path: "/tmp/session.jsonl",
    });
    expect(deps.writeFileSync).toHaveBeenCalled();
  });

  it("skips when throttled (cursor mtime < interval)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 10_000 }), // 10s ago
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("ingests when cursor mtime exceeds interval", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 120_000 }), // 2 min ago
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalled();
  });

  it("returns exitCode 0 on error (never blocks Claude)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
      post: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/session-snapshot.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `handleSessionSnapshot`**

Create `src/hooks/session-snapshot.ts`:

```typescript
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SnapshotDeps {
  statSync: (path: string) => { mtimeMs: number } | null;
  writeFileSync: (path: string, data: string) => void;
  snapshotIntervalSec: number;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
}

function defaultStatSync(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export async function handleSessionSnapshot(
  stdin: string,
  deps?: Partial<SnapshotDeps>,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin || "{}");
    const { session_id, cwd, transcript_path } = input;
    if (!session_id || !cwd || !transcript_path) {
      return { exitCode: 0, stdout: "" };
    }

    const cursorPath = join(tmpdir(), `lcm-snap-${session_id}.json`);
    const _statSync = deps?.statSync ?? defaultStatSync;
    const intervalSec = deps?.snapshotIntervalSec ?? 60;

    // Throttle: stat cursor mtime, skip if within interval
    const stat = _statSync(cursorPath);
    if (stat && (Date.now() - stat.mtimeMs) < intervalSec * 1000) {
      return { exitCode: 0, stdout: "" };
    }

    // POST to /ingest — daemon handles delta via storedCount
    const _post = deps?.post;
    if (_post) {
      await _post("/ingest", { session_id, cwd, transcript_path });
    } else {
      const { DaemonClient } = await import("../daemon/client.js");
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const client = new DaemonClient(`http://127.0.0.1:${config.daemon?.port ?? 3737}`);
      await client.post("/ingest", { session_id, cwd, transcript_path });
    }

    // Touch cursor file
    const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
    _writeFileSync(cursorPath, JSON.stringify({ ts: Date.now() }));

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks/session-snapshot.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Add 5-second timeout to the handler**

In `src/hooks/session-snapshot.ts`, wrap the `client.post` call with `AbortSignal.timeout(5000)` or use the DaemonClient's timeout option. The spec requires a 5-second hard timeout on all daemon HTTP calls in hooks.

- [ ] **Step 6: Register in dispatch.ts**

In `src/hooks/dispatch.ts`:
- Add `"session-snapshot"` to `HOOK_COMMANDS` array (line 3). Note: this is a `const` tuple — TypeScript automatically updates the `HookCommand` union type since it's derived via `typeof HOOK_COMMANDS[number]`.
- Add a case to the switch statement (after `user-prompt`, before `default`):

```typescript
case "session-snapshot": {
  const { handleSessionSnapshot } = await import("./session-snapshot.js");
  return handleSessionSnapshot(stdinText);
}
```

- [ ] **Step 7: Update existing dispatch test**

In `test/hooks/dispatch.test.ts`, the `commandToEvent` map (line 35-39) must include the new command. The test iterates `HOOK_COMMANDS` and asserts every entry has a mapping. Add:

```typescript
const commandToEvent: Record<string, string> = {
  "compact": "PreCompact",
  "restore": "SessionStart",
  "session-end": "SessionEnd",
  "user-prompt": "UserPromptSubmit",
  "session-snapshot": "Stop",  // ← add this
};
```

Also add `handleSessionSnapshot` to the mock imports and the dispatch mapping test (line 69+).

- [ ] **Step 8: Register CLI subcommand in bin/lcm.ts**

After the `user-prompt` command block (after line 260), add:

```typescript
  // ─── session-snapshot (hook) ─────────────────────────────────────────────
  program
    .command("session-snapshot")
    .description("Rolling ingest snapshot (called by Stop hook)")
    .helpOption(false)
    .action(async () => {
      const { dispatchHook } = await import("../src/hooks/dispatch.js");
      const input = await readStdin();
      const r = await dispatchHook("session-snapshot", input);
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
    });
```

- [ ] **Step 9: Register Stop hook in plugin.json**

In `.claude-plugin/plugin.json`, add after the `UserPromptSubmit` hook block:

```json
"Stop": [
  {
    "matcher": "",
    "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" session-snapshot" }]
  }
]
```

- [ ] **Step 10: Run all hook tests**

Run: `npx vitest run test/hooks/ --reporter=verbose`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/hooks/session-snapshot.ts test/hooks/session-snapshot.test.ts src/hooks/dispatch.ts test/hooks/dispatch.test.ts bin/lcm.ts .claude-plugin/plugin.json
git commit -m "feat: add session-snapshot Stop hook for rolling ingest"
```

---

### Task 5: Inject `<learning-instruction>` in UserPromptSubmit

**Files:**
- Modify: `src/hooks/user-prompt.ts:36-38`
- Test: `test/hooks/user-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// Add to existing test/hooks/user-prompt.test.ts
it("includes learning-instruction block in output", async () => {
  mockClient.post.mockResolvedValue({ hints: ["some context hint"] });
  const result = await handleUserPromptSubmit(
    JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
    mockClient,
  );
  expect(result.stdout).toContain("<learning-instruction>");
  expect(result.stdout).toContain("lcm_store");
  expect(result.stdout).toContain("category:decision");
  expect(result.stdout).toContain("</learning-instruction>");
});

it("includes learning-instruction even when no memory-context hints", async () => {
  mockClient.post.mockResolvedValue({ hints: [] });
  const result = await handleUserPromptSubmit(
    JSON.stringify({ prompt: "test query", cwd: "/tmp/test", session_id: "s1" }),
    mockClient,
  );
  // No memory-context block, but learning-instruction is always present
  expect(result.stdout).toContain("<learning-instruction>");
  expect(result.stdout).not.toContain("<memory-context>");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/user-prompt.test.ts --reporter=verbose`
Expected: FAIL — output does not contain `<learning-instruction>`

- [ ] **Step 3: Update existing test that will break**

In `test/hooks/user-prompt.test.ts`, the test at line 39-40 asserts `expect(result.stdout).toBe("")` when hints are empty. This will break because stdout now contains `<learning-instruction>`. Update it:

```typescript
// Was: expect(result.stdout).toBe("");
// Now: empty hints still return the learning instruction
expect(result.stdout).toContain("<learning-instruction>");
expect(result.stdout).not.toContain("<memory-context>");
```

- [ ] **Step 4: Add the learning instruction block**

In `src/hooks/user-prompt.ts`, define the instruction constant and update the return logic:

```typescript
const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
- decision: architectural/design choice with trade-offs
- preference: user working style or tool preference
- root-cause: bug cause that took effort to uncover
- pattern: codebase convention not documented elsewhere
- gotcha: non-obvious pitfall or footgun
- solution: non-trivial fix worth remembering
- workflow: multi-step process that works

Usage: lcm_store(text: "concise insight with why", tags: ["category:decision"])
</learning-instruction>`;
```

Update the handler to always append the learning instruction. Change the early return for empty hints (lines 32-34) to still return the instruction:

```typescript
if (!result.hints || result.hints.length === 0) {
  return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
}

const snippets = result.hints.map((h) => `- ${h}`).join("\n");
const hint = `<memory-context>\nRelevant context from previous sessions (use lcm_expand for details):\n${snippets}\n</memory-context>`;
return { exitCode: 0, stdout: `${hint}\n${LEARNING_INSTRUCTION}` };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/hooks/user-prompt.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/user-prompt.ts test/hooks/user-prompt.test.ts
git commit -m "feat: inject learning-instruction in UserPromptSubmit for mid-session lcm_store"
```

---

### Task 6: Enhance SessionEnd — always compact + promote, record manifest

**Files:**
- Modify: `src/hooks/session-end.ts:44-89`
- Test: `test/hooks/session-end.test.ts`

- [ ] **Step 1: Update existing tests that will break**

In `test/hooks/session-end.test.ts`, two tests will fail because they assert compact does NOT fire below threshold:

- Line 58-64: `"does NOT fire compact when totalTokens is below threshold"` — delete or invert this test
- Line 66-75: `"does NOT fire compact when autoCompactMinTokens is 0 (disabled)"` — replace with `disableAutoCompact` test

Update the "below threshold" test to assert compact IS called:

```typescript
it("fires compact even when totalTokens is below old threshold", async () => {
  const { request } = await import("node:http");
  const client = createMockClient({ ingested: 5, totalTokens: 500 });
  const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
  await handleSessionEnd(stdin, client, 3737);
  // Compact now always fires
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/compact", method: "POST" }),
  );
});
```

Replace the "autoCompactMinTokens is 0" test with:

```typescript
it("skips compact when hooks.disableAutoCompact is true", async () => {
  const { loadDaemonConfig } = await import("../../src/daemon/config.js");
  vi.mocked(loadDaemonConfig).mockReturnValueOnce({
    compaction: { autoCompactMinTokens: 0 },
    hooks: { disableAutoCompact: true, snapshotIntervalSec: 60 },
  } as any);
  const { request } = await import("node:http");
  const client = createMockClient({ ingested: 100, totalTokens: 99999 });
  await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
  // Compact request for /compact should not fire, but /promote should
  const compactCalls = vi.mocked(request).mock.calls.filter(
    ([opts]: any) => opts.path === "/compact",
  );
  expect(compactCalls.length).toBe(0);
});
```

- [ ] **Step 2: Write new tests**

```typescript
it("fires promote after ingest (always)", async () => {
  const { request } = await import("node:http");
  const client = createMockClient({ ingested: 5, totalTokens: 100 });
  await handleSessionEnd(
    JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
    client, 3737,
  );
  const promoteCalls = vi.mocked(request).mock.calls.filter(
    ([opts]: any) => opts.path === "/promote",
  );
  expect(promoteCalls.length).toBe(1);
});

it("records session completion in ingest manifest", async () => {
  const client = createMockClient({ ingested: 5, totalTokens: 100 });
  await handleSessionEnd(
    JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
    client, 3737,
  );
  // Verify POST to /session-complete was fired
  const { request } = await import("node:http");
  const manifestCalls = vi.mocked(request).mock.calls.filter(
    ([opts]: any) => opts.path === "/session-complete",
  );
  expect(manifestCalls.length).toBe(1);
});
```

- [ ] **Step 3: Run tests to verify failures**

Run: `npx vitest run test/hooks/session-end.test.ts --reporter=verbose`
Expected: FAIL — promote and manifest not fired

- [ ] **Step 4: Add `firePromoteRequest` to session-end.ts**

In `src/hooks/session-end.ts`, add after `fireCompactRequest`:

```typescript
export function firePromoteRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/promote",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
  req.write(json);
  req.end();
}

export function fireSessionCompleteRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/session-complete",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    },
  });
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {});
  req.write(json);
  req.end();
}
```

- [ ] **Step 5: Update handleSessionEnd**

Replace lines 65-83 in `handleSessionEnd`:

```typescript
    const configPath = join(homedir(), ".lossless-claude", "config.json");
    const config = loadDaemonConfig(configPath);
    const disableCompact = config.hooks?.disableAutoCompact ?? false;

    if (!disableCompact) {
      fireCompactRequest(daemonPort, {
        session_id: input.session_id,
        cwd: input.cwd,
        skip_ingest: true,
        client: "claude",
      });
    }

    // Always promote
    firePromoteRequest(daemonPort, { cwd: input.cwd });

    // Record session completion in manifest
    fireSessionCompleteRequest(daemonPort, {
      session_id: input.session_id,
      cwd: input.cwd,
      message_count: ingestResult.ingested,
    });
```

- [ ] **Step 6: Add `/session-complete` daemon route**

Create `src/daemon/routes/session-complete.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import { projectDbPath, ensureProjectDir } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";

export function createSessionCompleteHandler(): RouteHandler {
  return async (_req, res, body) => {
    const { session_id, cwd, message_count } = JSON.parse(body || "{}");
    if (!session_id || !cwd) {
      sendJson(res, 400, { error: "session_id and cwd required" });
      return;
    }
    ensureProjectDir(cwd);
    const db = new DatabaseSync(projectDbPath(cwd));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      db.prepare(
        "INSERT OR REPLACE INTO session_ingest_log (session_id, message_count) VALUES (?, ?)",
      ).run(session_id, message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } finally {
      db.close();
    }
  };
}
```

Register in `src/daemon/server.ts`:

```typescript
import { createSessionCompleteHandler } from "./routes/session-complete.js";
// In the routes.set block:
routes.set("POST /session-complete", createSessionCompleteHandler());
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/hooks/session-end.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 8: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
git add src/hooks/session-end.ts src/daemon/routes/session-complete.ts src/daemon/server.ts test/hooks/session-end.test.ts
git commit -m "feat: SessionEnd always compacts and promotes, record manifest (#94)"
```

---

### Task 7: Wire `ensureBootstrapped()` into hook dispatch

**Files:**
- Modify: `src/hooks/dispatch.ts:10-22`
- Test: `test/hooks/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

In the existing `test/hooks/dispatch.test.ts`, add a test that verifies the bootstrap call. The existing test file already mocks all hook handlers at module scope — add `ensureBootstrapped` to the mock list:

```typescript
// At the top of test/hooks/dispatch.test.ts, add to existing vi.mock calls:
vi.mock("../../src/bootstrap.js", () => ({
  ensureBootstrapped: vi.fn().mockResolvedValue(undefined),
}));

// Import it:
import { ensureBootstrapped } from "../../src/bootstrap.js";

// Add test in the dispatchHook describe block:
it("calls ensureBootstrapped with session_id before dispatching", async () => {
  vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });
  vi.mocked(ensureBootstrapped).mockClear();
  await dispatchHook("compact", JSON.stringify({ session_id: "test-sess-123" }));
  expect(ensureBootstrapped).toHaveBeenCalledWith("test-sess-123");
});

it("does not block hooks if ensureBootstrapped throws", async () => {
  vi.mocked(ensureBootstrapped).mockRejectedValueOnce(new Error("bootstrap failed"));
  vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });
  const result = await dispatchHook("compact", JSON.stringify({ session_id: "s1" }));
  expect(result.exitCode).toBe(0); // hook still ran
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/dispatch.test.ts --reporter=verbose`
Expected: FAIL — ensureBootstrapped not imported/called in dispatch.ts

- [ ] **Step 3: Add ensureBootstrapped call to dispatchHook**

In `src/hooks/dispatch.ts`, at the top of `dispatchHook` (before `validateAndFixHooks()`):

```typescript
export async function dispatchHook(
  command: HookCommand,
  stdinText: string,
): Promise<{ exitCode: number; stdout: string }> {
  // Lazy bootstrap: create config + start daemon on first hook fire
  try {
    const { session_id } = JSON.parse(stdinText || "{}");
    if (session_id) {
      const { ensureBootstrapped } = await import("../bootstrap.js");
      await ensureBootstrapped(session_id);
    }
  } catch {} // bootstrap failure should not block hooks

  validateAndFixHooks();
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks/dispatch.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/hooks/dispatch.ts test/hooks/dispatch.test.ts
git commit -m "feat: wire ensureBootstrapped() into hook dispatch for lazy bootstrap"
```

---

### Task 8: Add `lcm import` idempotency check

**Files:**
- Modify: `src/import.ts` (the `importSessions` function)
- Test: `test/import.test.ts`

- [ ] **Step 1: Write the failing test**

The `importSessions` function in `src/import.ts` iterates session files and POSTs each to the daemon's `/ingest`. To add idempotency, it should check the daemon before sending. Add a test that uses a real daemon:

```typescript
// Add to existing import test file (test/import*.test.ts)
it("skips sessions already recorded in session_ingest_log", async () => {
  // Setup: create a session file, ingest it, mark it complete
  const sessionId = "already-ingested-session";
  const dbPath = projectDbPath(testCwd);
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  db.prepare("INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?)")
    .run(sessionId, 10);
  db.close();

  // Act: run import with a session file whose session_id matches
  // Assert: the session is skipped, ingest count is 0 for that session
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/import*.test.ts --reporter=verbose`
Expected: FAIL — import doesn't check session_ingest_log

- [ ] **Step 3: Add session_ingest_log check**

In `src/import.ts`, in the session processing loop, before calling the daemon's `/ingest`:

1. Extract the `session_id` from the transcript file (first line of JSONL contains session metadata, or derive from the file path which is `{session-id}.jsonl`)
2. Query the project database for the session_id in `session_ingest_log`:

```typescript
function isSessionAlreadyIngested(dbPath: string, sessionId: string): boolean {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const row = db.prepare("SELECT 1 FROM session_ingest_log WHERE session_id = ?").get(sessionId);
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return false; // table may not exist yet — proceed with import
  }
}
```

Call this before each session's ingest. If true, skip with verbose log: `"  ⊘ {sessionId} — already ingested, skipping"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/import*.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/import.ts test/import*.test.ts
git commit -m "feat: lcm import checks session_ingest_log for idempotency"
```

---

### Task 9: Update `install()` to use `ensureCore()`

**Files:**
- Modify: `installer/install.ts:189-257`
- Test: `test/installer/install.test.ts`

- [ ] **Step 1: Refactor install() to call ensureCore()**

Replace the config creation, settings merge, and daemon start sections in `install()` with:

```typescript
// 1-3. Core setup (config + settings cleanup + daemon)
await ensureCore({
  configPath,
  settingsPath,
  existsSync: deps.existsSync,
  readFileSync: deps.readFileSync,
  writeFileSync: deps.writeFileSync,
  mkdirSync: deps.mkdirSync,
  ensureDaemon: deps.ensureDaemon ?? (async (opts) => {
    const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
    return ensureDaemon(opts);
  }),
});
```

Keep the interactive parts after: `pickSummarizer()` (overwrite config), commands copy, MCP server registration, doctor.

- [ ] **Step 2: Run installer tests**

Run: `npx vitest run test/installer/ --reporter=verbose`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add installer/install.ts
git commit -m "refactor: install() delegates to ensureCore() for shared bootstrap logic"
```

---

### Task 10: Quality validation — synthetic session test

**Files:**
- Create: `test/e2e/continuous-learning.test.ts`
- Create: `test/fixtures/synthetic-session.json`

- [ ] **Step 1: Create the synthetic session fixture**

Create `test/fixtures/synthetic-session.json` — a realistic session transcript containing dialogue that exercises all 7 categories. Structure as an array of `{ role, content, tokenCount }` messages:

1. **decision**: User and Claude discuss database choice, settle on SQLite with trade-off reasoning
2. **preference**: User reveals "I prefer small, focused PRs over large ones"
3. **root-cause**: Debugging session where Claude discovers a race condition in cursor file writes
4. **pattern**: Claude discovers the codebase uses dependency injection via interfaces for all hook handlers
5. **gotcha**: An import path that breaks when running from a symlinked directory
6. **solution**: A non-trivial fix for fire-and-forget HTTP with socket.unref()
7. **workflow**: The complete PR shipping process (push, Copilot review, fix, merge)
8. **Noise**: Greetings, status updates, simple Q&A that should NOT be promoted

- [ ] **Step 2: Write the integration test**

```typescript
// test/e2e/continuous-learning.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";

describe("continuous learning quality", () => {
  // Spin up a real daemon on a random port
  // Ingest the synthetic session
  // Run compact + promote
  // Query promoted entries

  it("produces at least 1 promoted entry per category", async () => {
    // Assert categories: decision, preference, root-cause, pattern, gotcha, solution, workflow
  });

  it("promoted entries are concise (< 3 sentences)", async () => {
    // Check promoted content length
  });

  it("noise ratio is below 20%", async () => {
    // Count entries that don't match any category tag vs total
  });

  it("promoted entries are retrievable via prompt-search", async () => {
    // POST /prompt-search with relevant queries, verify hits
  });
});

describe("lcm_store round-trip", () => {
  it("lcm_store writes to promoted table and prompt-search retrieves it", async () => {
    // POST /store with { text: "chose SQLite for simplicity", tags: ["category:decision"], cwd }
    // POST /prompt-search with { query: "database choice", cwd, session_id }
    // Assert: hints array contains a match referencing SQLite
  });
});

describe("rolling ingest path", () => {
  it("incremental ingest + compact produces same quality as full ingest", async () => {
    // Ingest in 3 batches (simulating Stop hook snapshots)
    // Compact + promote
    // Compare promoted entries to full-ingest baseline
  });
});

describe("failure recovery", () => {
  it("lcm_store failure falls back to rolling ingest", async () => {
    // Ingest session without any direct lcm_store calls
    // Compact + promote
    // Verify insights still surface (lower signal but not lost)
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `npx vitest run test/e2e/continuous-learning.test.ts --reporter=verbose`
Expected: PASS (this test requires a real daemon with a summarizer — may need `LCM_SUMMARY_PROVIDER=disabled` or mock summarizer for CI)

- [ ] **Step 4: Commit**

```bash
git add test/e2e/continuous-learning.test.ts test/fixtures/synthetic-session.json
git commit -m "test: add synthetic session quality validation for continuous learning"
```

---

## Task Dependency Graph

```
Task 1 (config) ──────────────────────┐
Task 2 (migration) ───────────────────┤
Task 3 (ensureCore) ──┬→ Task 7 (wire bootstrap into dispatch)
                      └→ Task 9 (install() refactor)
Task 4 (session-snapshot) ────────────┤
Task 5 (learning-instruction) ────────┤
Task 6 (session-end enhance) ← needs Task 1 (hooks config) + Task 2 (migration table)
Task 8 (import idempotency) ← needs Task 2 (migration table)
                                      │
                             Task 10 (e2e quality test) ← depends on all above
```

**Parallelization:** Tasks 1, 2, 3, 4, 5 are fully independent. Task 6 needs Tasks 1+2. Task 7 needs Task 3. Task 8 needs Task 2. Task 9 needs Task 3. Task 10 is the integration capstone.
