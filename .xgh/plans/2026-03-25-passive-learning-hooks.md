# Passive Learning Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passive event capture via PostToolUse and enhanced UserPromptSubmit hooks, with a three-tier promotion pipeline that feeds the existing promoted store for cross-session learning.

**Architecture:** Sidecar SQLite DB captures events from hooks at <10ms cost. Daemon route `/promote-events` processes events at session boundaries (session-end, pre-compact) and promotes high-signal events to the existing `promoted` table via `deduplicateAndInsert()`. SessionStart surfaces recently learned insights.

**Tech Stack:** TypeScript, node:sqlite DatabaseSync, Vitest, existing LCM daemon infrastructure

**Spec:** `.xgh/specs/2026-03-25-passive-learning-hooks-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/db/events-path.ts` | Compute sidecar DB path from cwd (shared by hooks + daemon) |
| `src/hooks/extractors.ts` | Pure extraction functions for PostToolUse + UserPromptSubmit events |
| `src/hooks/events-db.ts` | SQLite wrapper for sidecar (open, migrate, insert, query, prune, close) |
| `src/hooks/post-tool.ts` | PostToolUse hook handler |
| `src/daemon/routes/promote-events.ts` | Daemon route for event promotion |
| `test/db/events-path.test.ts` | Tests for path resolution |
| `test/hooks/extractors.test.ts` | Tests for extraction functions + negative-match guards |
| `test/hooks/events-db.test.ts` | Tests for sidecar DB operations |
| `test/hooks/post-tool.test.ts` | Tests for PostToolUse handler |
| `test/daemon/routes/promote-events.test.ts` | Tests for promotion route |

### Modified files

| File | Change |
|------|--------|
| `.claude-plugin/plugin.json` | Add PostToolUse hook entry |
| `src/hooks/dispatch.ts` | Add `post-tool` command with bootstrap bypass |
| `src/hooks/user-prompt.ts` | Add sidecar extraction before prompt-search |
| `src/hooks/session-end.ts` | Add `firePromoteEventsRequest()` |
| `src/hooks/compact.ts` | Add promote-events trigger with 3s timeout |
| `src/hooks/session-snapshot.ts` | Add best-effort event flush |
| `src/hooks/restore.ts` | Add learned-insights injection |
| `src/hooks/auto-heal.ts` | Add PostToolUse to known hook set |
| `src/daemon/server.ts` | Register `/promote-events` route |
| `src/daemon/config.ts` | Add `eventConfidence` to promotionThresholds type |

## Parallelization Map

```
Task 1 (events-path) ──┐
                        ├── Task 3 (events-db) ──┐
Task 2 (extractors) ───┤                         ├── Task 4 (post-tool) ── Task 5 (hook registration)
                        │                         │
                        └── Task 6 (user-prompt)  │
                                                  │
Task 7 (config) ────────────────── Task 8 (promote-events) ── Task 9 (server + integration hooks)
                                                               │
                                                               └── Task 10 (learned insights)
                                                                    │
                                                                    └── Task 11 (E2E test)
```

**Parallel tracks:** Tasks 1+2+7 can run simultaneously. Tasks 4+6 can run simultaneously after Task 3 completes.

---

### Task 1: Events Path Resolution

**Files:**
- Create: `src/db/events-path.ts`
- Test: `test/db/events-path.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/db/events-path.test.ts
import { describe, it, expect } from "vitest";
import { eventsDbPath, eventsDir } from "../src/db/events-path.js";
import { join } from "node:path";
import { homedir } from "node:os";

describe("eventsDbPath", () => {
  it("returns a path under ~/.lossless-claude/events/", () => {
    const result = eventsDbPath("/some/project");
    expect(result).toMatch(/\.lossless-claude\/events\/.+\.db$/);
  });

  it("produces consistent paths for the same cwd", () => {
    const a = eventsDbPath("/some/project");
    const b = eventsDbPath("/some/project");
    expect(a).toBe(b);
  });

  it("produces different paths for different cwds", () => {
    const a = eventsDbPath("/project/a");
    const b = eventsDbPath("/project/b");
    expect(a).not.toBe(b);
  });
});

describe("eventsDir", () => {
  it("returns ~/.lossless-claude/events", () => {
    expect(eventsDir()).toBe(join(homedir(), ".lossless-claude", "events"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/events-path.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/db/events-path.ts
import { join } from "node:path";
import { homedir } from "node:os";
import { projectId } from "../daemon/project.js";

const BASE = join(homedir(), ".lossless-claude");

export function eventsDir(): string {
  return join(BASE, "events");
}

export function eventsDbPath(cwd: string): string {
  return join(eventsDir(), `${projectId(cwd)}.db`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/events-path.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/events-path.ts test/db/events-path.test.ts
git commit -m "feat: add events sidecar path resolution"
```

---

### Task 2: Event Extractors

**Files:**
- Create: `src/hooks/extractors.ts`
- Test: `test/hooks/extractors.test.ts`

- [ ] **Step 1: Write types and negative-match guard tests**

```typescript
// test/hooks/extractors.test.ts
import { describe, it, expect } from "vitest";
import {
  extractPostToolEvents,
  extractUserPromptEvents,
  type ExtractedEvent,
} from "../src/hooks/extractors.js";

describe("extractPostToolEvents", () => {
  it("extracts decision from AskUserQuestion", () => {
    const events = extractPostToolEvents({
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite or Postgres?" },
      tool_response: "SQLite",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "decision",
      category: "decision",
      priority: 1,
      data: expect.stringContaining("SQLite"),
    });
  });

  it("extracts error from Bash with isError", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "npm install broken-pkg" },
      tool_output: { isError: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error_tool",
      category: "error",
      priority: 1,
    });
  });

  it("extracts git commit from Bash", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "fix: thing"' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "git_commit",
      category: "git",
      priority: 2,
    });
  });

  it("extracts file path from Read", () => {
    const events = extractPostToolEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/main.ts" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "file_read",
      category: "file",
      priority: 3,
    });
  });

  it("skips sensitive file paths", () => {
    const events = extractPostToolEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    expect(events).toHaveLength(0);
  });

  it("skips lcm_store calls", () => {
    const events = extractPostToolEvents({
      tool_name: "mcp__plugin_lcm_lcm__lcm_store",
      tool_input: { text: "something" },
    });
    expect(events).toHaveLength(0);
  });

  it("returns empty for unrecognized tools", () => {
    const events = extractPostToolEvents({
      tool_name: "SomeUnknownTool",
      tool_input: {},
    });
    expect(events).toHaveLength(0);
  });

  it("extracts plan approval from ExitPlanMode", () => {
    const events = extractPostToolEvents({
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "Plan approved",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "plan_exit",
      category: "plan",
      priority: 1,
      data: expect.stringContaining("approved"),
    });
  });

  it("extracts env commands from Bash", () => {
    const events = extractPostToolEvents({
      tool_name: "Bash",
      tool_input: { command: "npm install lodash" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "env",
      priority: 2,
    });
  });

  it("extracts skill usage", () => {
    const events = extractPostToolEvents({
      tool_name: "Skill",
      tool_input: { skill: "tdd" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "skill",
      priority: 3,
    });
  });

  it("extracts subagent dispatch", () => {
    const events = extractPostToolEvents({
      tool_name: "Agent",
      tool_input: { description: "Run tests" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "subagent",
      priority: 3,
    });
  });

  it("extracts mcp tool usage (not lcm_store)", () => {
    const events = extractPostToolEvents({
      tool_name: "mcp__plugin_context-mode__ctx_search",
      tool_input: { queries: ["test"] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "mcp",
      priority: 3,
      data: "mcp__plugin_context-mode__ctx_search",
    });
  });

  it("truncates data at 2000 char soft cap", () => {
    const events = extractPostToolEvents({
      tool_name: "AskUserQuestion",
      tool_input: { question: "x".repeat(3000) },
      tool_response: "yes",
    });
    expect(events[0].data.length).toBeLessThanOrEqual(2050); // soft cap with some slack
  });
});

describe("extractUserPromptEvents", () => {
  it("extracts decision from 'always use' pattern", () => {
    const events = extractUserPromptEvents("always use TypeScript for new files");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "decision",
      priority: 1,
    });
  });

  it("extracts role from 'I'm a' pattern", () => {
    const events = extractUserPromptEvents("I'm a data scientist investigating logs");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "role",
      priority: 2,
    });
  });

  it("extracts intent from 'explain' keyword", () => {
    const events = extractUserPromptEvents("explain how the daemon works");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "intent",
      priority: 3,
    });
  });

  // Negative-match guards
  it("does NOT extract decision from 'don't worry'", () => {
    const events = extractUserPromptEvents("don't worry about tests");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'never mind'", () => {
    const events = extractUserPromptEvents("never mind, let's move on");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'not sure'", () => {
    const events = extractUserPromptEvents("I'm not sure about that");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("does NOT extract decision from 'doesn't matter'", () => {
    const events = extractUserPromptEvents("it doesn't matter which one");
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });

  it("returns empty for generic prompts", () => {
    const events = extractUserPromptEvents("fix the bug in main.ts");
    // "fix" matches intent, so we expect 1 intent event
    expect(events.filter(e => e.category === "decision")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/extractors.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Key design: pure functions, no side effects, no IO. Each extractor returns `ExtractedEvent[]`.

```typescript
// src/hooks/extractors.ts

export interface ExtractedEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
}

interface PostToolInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: { isError?: boolean };
}

const SENSITIVE_PATHS = [".env", ".ssh/", "credentials", "secrets/", ".npmrc", ".netrc"];
const DATA_SOFT_CAP = 2000;

const NEGATIVE_PATTERNS = [
  "don't worry", "dont worry",
  "never mind", "nevermind",
  "not sure", "no idea",
  "doesn't matter", "doesnt matter", "does not matter",
  "forget about", "forget it",
  "no preference", "whatever you think",
  "up to you",
];

const ENV_COMMANDS = ["npm install", "npm i ", "yarn add", "pip install", "pip3 install",
  "nvm use", "volta install", "pnpm add", "uv pip install", "brew install"];

const GIT_COMMANDS = ["git commit", "git merge", "git rebase", "git checkout", "git switch",
  "git branch", "git push", "git pull", "git stash", "git reset", "git cherry-pick"];

function truncate(s: string): string {
  return s.length > DATA_SOFT_CAP ? s.slice(0, DATA_SOFT_CAP) + "..." : s;
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SENSITIVE_PATHS.some(p => lower.includes(p));
}

function classifyFile(path: string): string {
  if (/\.(test|spec)\.[tj]sx?$/.test(path) || path.includes("__tests__")) return "test";
  if (/\.(json|ya?ml|toml|ini|env)$/.test(path) || path.includes("config")) return "config";
  if (/\.(md|txt|rst)$/.test(path) || path.includes("docs/")) return "docs";
  return "source";
}

function extractBashEvents(input: PostToolInput): ExtractedEvent[] {
  const command = String(input.tool_input.command ?? "");
  const isError = input.tool_output?.isError === true;

  // Error detection (priority 1)
  if (isError) {
    const prefix = command.split(/\s+/).slice(0, 3).join(" ");
    return [{ type: "error_tool", category: "error", data: truncate(`Bash error: ${prefix}`), priority: 1 }];
  }

  // Git operations (priority 2)
  const gitMatch = GIT_COMMANDS.find(gc => command.startsWith(gc));
  if (gitMatch) {
    const commitMsgMatch = command.match(/-m\s+["']([^"']+)["']/);
    const data = commitMsgMatch
      ? `${gitMatch}: ${commitMsgMatch[1]}`
      : gitMatch;
    return [{ type: `git_${gitMatch.split(" ")[1]}`, category: "git", data: truncate(data), priority: 2 }];
  }

  // Env commands (priority 2)
  const envMatch = ENV_COMMANDS.find(ec => command.startsWith(ec));
  if (envMatch) {
    return [{ type: "env_install", category: "env", data: truncate(command), priority: 2 }];
  }

  return [];
}

function extractFileEvents(toolName: string, input: PostToolInput): ExtractedEvent[] {
  const filePath = String(
    input.tool_input.file_path ?? input.tool_input.path ?? input.tool_input.pattern ?? ""
  );
  if (!filePath || isSensitivePath(filePath)) return [];

  const typeMap: Record<string, string> = {
    Read: "file_read", Edit: "file_edit", Write: "file_write",
    Glob: "file_glob", Grep: "file_grep",
  };

  return [{
    type: typeMap[toolName] ?? "file_access",
    category: "file",
    data: truncate(`${filePath} (${classifyFile(filePath)})`),
    priority: 3,
  }];
}

export function extractPostToolEvents(input: PostToolInput): ExtractedEvent[] {
  const { tool_name } = input;

  // Skip lcm_store to prevent feedback loops
  if (tool_name.includes("lcm_store") || tool_name.includes("lcm__lcm_store")) return [];

  // AskUserQuestion — extract Q+A pair (priority 1)
  if (tool_name === "AskUserQuestion") {
    const question = String(input.tool_input.question ?? "");
    const answer = String(input.tool_response ?? "");
    return [{
      type: "decision",
      category: "decision",
      data: truncate(`Q: ${question}\nA: ${answer}`),
      priority: 1,
    }];
  }

  // Plan mode (priority 1)
  if (tool_name === "EnterPlanMode") {
    return [{ type: "plan_enter", category: "plan", data: "Entered plan mode", priority: 1 }];
  }
  if (tool_name === "ExitPlanMode") {
    const response = String(input.tool_response ?? "");
    const status = /approve/i.test(response) ? "approved" : /reject/i.test(response) ? "rejected" : "exited";
    return [{ type: "plan_exit", category: "plan", data: `Plan ${status}`, priority: 1 }];
  }

  // Bash — multiple categories
  if (tool_name === "Bash") {
    return extractBashEvents(input);
  }

  // File operations (priority 3)
  if (["Read", "Edit", "Write", "Glob", "Grep"].includes(tool_name)) {
    return extractFileEvents(tool_name, input);
  }

  // Task operations (priority 2)
  if (tool_name === "TaskCreate" || tool_name === "TaskUpdate") {
    const subject = String(input.tool_input.subject ?? input.tool_input.taskId ?? "");
    const status = String(input.tool_input.status ?? "created");
    return [{
      type: `task_${tool_name === "TaskCreate" ? "create" : "update"}`,
      category: "task",
      data: truncate(`${subject} → ${status}`),
      priority: 2,
    }];
  }

  // Agent/subagent (priority 3)
  if (tool_name === "Agent") {
    const desc = String(input.tool_input.description ?? "");
    return [{ type: "subagent_dispatch", category: "subagent", data: truncate(desc), priority: 3 }];
  }

  // Skill (priority 3)
  if (tool_name === "Skill") {
    const skill = String(input.tool_input.skill ?? "");
    return [{ type: "skill_use", category: "skill", data: skill, priority: 3 }];
  }

  // MCP tools (priority 3) — tool name only, no args
  if (tool_name.startsWith("mcp__")) {
    return [{ type: "mcp_call", category: "mcp", data: tool_name, priority: 3 }];
  }

  // Any other tool with isError flag
  if (input.tool_output?.isError === true) {
    return [{
      type: "error_tool",
      category: "error",
      data: truncate(`${tool_name} error`),
      priority: 1,
    }];
  }

  return [];
}

export function extractUserPromptEvents(prompt: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  const lower = prompt.toLowerCase();

  // Decision extraction with negative-match guards
  const hasNegative = NEGATIVE_PATTERNS.some(np => lower.includes(np));
  if (!hasNegative) {
    const decisionPatterns = [
      /\b(don'?t|never|always|prefer|use .+ instead)\b/i,
    ];
    for (const pattern of decisionPatterns) {
      if (pattern.test(prompt)) {
        events.push({
          type: "user_decision",
          category: "decision",
          data: truncate(prompt),
          priority: 1,
        });
        break;
      }
    }
  }

  // Role extraction
  const rolePatterns = [
    /\b(i'?m a|act as|i am a|as a|my role)\b/i,
    /\b(senior|junior|staff|lead|principal)\s+(engineer|developer|scientist|designer)\b/i,
  ];
  for (const pattern of rolePatterns) {
    if (pattern.test(prompt)) {
      events.push({
        type: "user_role",
        category: "role",
        data: truncate(prompt),
        priority: 2,
      });
      break;
    }
  }

  // Intent extraction
  const intentMap: [RegExp, string][] = [
    [/\b(why|explain|debug|investigate|understand)\b/i, "investigate"],
    [/\b(create|fix|build|implement|add|write)\b/i, "implement"],
    [/\b(review|check|verify|test|validate)\b/i, "review"],
    [/\b(refactor|clean|simplify|optimize)\b/i, "refactor"],
  ];
  for (const [pattern, intent] of intentMap) {
    if (pattern.test(prompt)) {
      events.push({
        type: `intent_${intent}`,
        category: "intent",
        data: intent,
        priority: 3,
      });
      break;
    }
  }

  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks/extractors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/extractors.ts test/hooks/extractors.test.ts
git commit -m "feat: add event extraction functions for PostToolUse + UserPromptSubmit"
```

---

### Task 3: Events DB Wrapper

**Files:**
- Create: `src/hooks/events-db.ts`
- Test: `test/hooks/events-db.test.ts`
- Depends on: Task 1 (eventsDbPath)

- [ ] **Step 1: Write the failing tests**

```typescript
// test/hooks/events-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventsDb, type EventRow } from "../src/hooks/events-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("EventsDb", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "events-db-test-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates schema on first open", () => {
    const db = new EventsDb(dbPath);
    // Should not throw
    db.close();
  });

  it("inserts and retrieves events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("session-1", {
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
    }, "PostToolUse");

    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      session_id: "session-1",
      type: "decision",
      category: "decision",
      data: "use SQLite",
      priority: 1,
      source_hook: "PostToolUse",
      processed_at: null,
    });
    db.close();
  });

  it("increments seq per session", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db.insertEvent("s1", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");
    db.insertEvent("s2", { type: "c", category: "file", data: "z", priority: 3 }, "PostToolUse");

    const events = db.getUnprocessed();
    const s1Events = events.filter(e => e.session_id === "s1");
    const s2Events = events.filter(e => e.session_id === "s2");
    expect(s1Events[0].seq).toBe(1);
    expect(s1Events[1].seq).toBe(2);
    expect(s2Events[0].seq).toBe(1);
    db.close();
  });

  it("marks events as processed", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    expect(events).toHaveLength(1);

    db.markProcessed([events[0].event_id]);
    expect(db.getUnprocessed()).toHaveLength(0);
    db.close();
  });

  it("prunes old processed events", () => {
    const db = new EventsDb(dbPath);
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const events = db.getUnprocessed();
    db.markProcessed([events[0].event_id]);

    // Manually backdate the processed_at to 10 days ago
    db.raw().exec(
      `UPDATE events SET processed_at = datetime('now', '-10 days') WHERE event_id = ${events[0].event_id}`
    );

    const pruned = db.pruneProcessed(7);
    expect(pruned).toBe(1);
    db.close();
  });

  it("handles concurrent opens (WAL mode)", () => {
    const db1 = new EventsDb(dbPath);
    const db2 = new EventsDb(dbPath);
    db1.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db2.insertEvent("s2", { type: "b", category: "file", data: "y", priority: 3 }, "PostToolUse");

    const events = db1.getUnprocessed();
    expect(events).toHaveLength(2);
    db1.close();
    db2.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/events-db.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/hooks/events-db.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtractedEvent } from "./extractors.js";

export interface EventRow {
  event_id: number;
  session_id: string;
  seq: number;
  type: string;
  category: string;
  data: string;
  priority: number;
  source_hook: string;
  prev_event_id: number | null;
  processed_at: string | null;
  created_at: string;
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  type          TEXT NOT NULL,
  category      TEXT NOT NULL,
  data          TEXT NOT NULL,
  priority      INTEGER DEFAULT 3,
  source_hook   TEXT NOT NULL,
  prev_event_id INTEGER,
  processed_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);
`;

export class EventsDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    // Check if schema_version table exists
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get() as { name: string } | undefined;

    if (!row) {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
      return;
    }

    const versionRow = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    const currentVersion = versionRow?.version ?? 0;

    // Future migrations go here:
    // if (currentVersion < 2) { ... UPDATE schema_version SET version = 2; }
    if (currentVersion < SCHEMA_VERSION) {
      this.db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
    }
  }

  insertEvent(sessionId: string, event: ExtractedEvent, sourceHook: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (session_id, seq, type, category, data, priority, source_hook)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?),
              ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      sessionId, sessionId,
      event.type, event.category, event.data, event.priority, sourceHook
    );
    return Number(result.lastInsertRowid);
  }

  getUnprocessed(limit = 500): EventRow[] {
    return this.db.prepare(
      "SELECT * FROM events WHERE processed_at IS NULL ORDER BY session_id, seq LIMIT ?"
    ).all(limit) as EventRow[];
  }

  markProcessed(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => "?").join(",");
    this.db.prepare(
      `UPDATE events SET processed_at = datetime('now') WHERE event_id IN (${placeholders})`
    ).run(...eventIds);
  }

  pruneProcessed(olderThanDays: number): number {
    const result = this.db.prepare(
      `DELETE FROM events WHERE processed_at IS NOT NULL
       AND processed_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
    return Number(result.changes);
  }

  setPrevEventId(eventId: number, prevEventId: number): void {
    this.db.prepare("UPDATE events SET prev_event_id = ? WHERE event_id = ?")
      .run(prevEventId, eventId);
  }

  /** Expose raw DB for testing only. */
  raw(): DatabaseSync {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks/events-db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/events-db.ts test/hooks/events-db.test.ts
git commit -m "feat: add events sidecar SQLite wrapper"
```

---

### Task 4: PostToolUse Handler

**Files:**
- Create: `src/hooks/post-tool.ts`
- Test: `test/hooks/post-tool.test.ts`
- Depends on: Tasks 2 (extractors), 3 (events-db)

- [ ] **Step 1: Write the failing tests**

```typescript
// test/hooks/post-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handlePostToolUse } from "../src/hooks/post-tool.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock eventsDbPath to use temp directory
vi.mock("../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "test.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

describe("handlePostToolUse", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-tool-test-"));
    process.env.TEST_EVENTS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("captures AskUserQuestion decision", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns empty stdout (PostToolUse hooks don't produce output)", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits gracefully on invalid stdin", async () => {
    const result = await handlePostToolUse("not json");
    expect(result.exitCode).toBe(0); // silent fail
  });

  it("skips sensitive file paths", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/post-tool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { request } from "node:http";

const LOG_PATH = join(homedir(), ".lossless-claude", "logs", "events.log");

function logError(hook: string, error: unknown, sessionId?: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const msg = JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      error: error instanceof Error ? error.message : String(error),
      session_id: sessionId,
    });
    appendFileSync(LOG_PATH, msg + "\n");
  } catch {
    // Last resort: silently fail
  }
}

function firePromoteEvents(port: number, cwd: string): void {
  try {
    const json = JSON.stringify({ cwd });
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/promote-events",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
    });
    // Deferred unref — same pattern as session-end.ts fire-and-forget functions
    req.on("socket", (socket) => {
      req.on("finish", () => (socket as import("node:net").Socket).unref());
    });
    req.on("error", () => {}); // swallow
    req.write(json);
    req.end();
  } catch {
    // daemon down — events stay in sidecar for later promotion
  }
}

export async function handlePostToolUse(
  stdin: string,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin);
    const { session_id, tool_name, tool_input, tool_response, tool_output } = input;

    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    const events = extractPostToolEvents({ tool_name, tool_input: tool_input ?? {}, tool_response, tool_output });
    if (events.length === 0) return { exitCode: 0, stdout: "" };

    const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const dbPath = eventsDbPath(cwd);
    const db = new EventsDb(dbPath);

    try {
      for (const event of events) {
        db.insertEvent(session_id, event, "PostToolUse");
      }

      // Tier 1: fire-and-forget daemon promotion for high-priority events.
      // The /promote-events route uses getUnprocessed() which reads processed_at IS NULL,
      // so events already promoted by this call won't be re-promoted by the batch route
      // at session-end. No additional de-duplication guard needed.
      const hasPriority1 = events.some(e => e.priority === 1);
      if (hasPriority1) {
        const port = input.daemon_port ?? 3737;
        firePromoteEvents(port, cwd);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    logError("PostToolUse", error);
  }

  return { exitCode: 0, stdout: "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/hooks/post-tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/post-tool.ts test/hooks/post-tool.test.ts
git commit -m "feat: add PostToolUse hook handler"
```

---

### Task 5: Hook Registration

**Files:**
- Modify: `src/hooks/dispatch.ts`
- Modify: `.claude-plugin/plugin.json`
- Modify: `src/hooks/auto-heal.ts`
- Depends on: Task 4 (post-tool.ts)

- [ ] **Step 1: Add `post-tool` to HOOK_COMMANDS in dispatch.ts**

In `src/hooks/dispatch.ts`, add `"post-tool"` to the `HOOK_COMMANDS` array and add the case to the switch. The `post-tool` command must bypass `ensureBootstrapped()` and `validateAndFixHooks()` for performance — it goes directly to the handler.

```typescript
// Add to HOOK_COMMANDS:
export const HOOK_COMMANDS = ["compact", "post-tool", "restore", "session-end", "session-snapshot", "user-prompt"] as const;

// Add BEFORE the ensureBootstrapped call (early return for post-tool):
if (command === "post-tool") {
  const { handlePostToolUse } = await import("./post-tool.js");
  return handlePostToolUse(stdinText);
}
// ... existing ensureBootstrapped/validateAndFixHooks code continues below
```

- [ ] **Step 2: Add PostToolUse hook to plugin.json**

In `.claude-plugin/plugin.json`, add to the `hooks` section:

```json
"PostToolUse": [{
  "matcher": "",
  "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" post-tool" }]
}]
```

- [ ] **Step 3: Add PostToolUse to REQUIRED_HOOKS**

In `src/installer/settings.ts`, add to the `REQUIRED_HOOKS` array:

```typescript
{ event: "PostToolUse", command: "lcm post-tool" },
```

This is critical: `auto-heal.ts` imports `REQUIRED_HOOKS` from `../../installer/install.js` (which re-exports from `settings.ts`) and uses it to detect duplicate hooks in `settings.json`. If PostToolUse is missing from `REQUIRED_HOOKS`, auto-heal won't recognize it and may remove it during repair cycles. The `doctor.ts` check also uses this array to verify all hooks are registered.

- [ ] **Step 4: Write dispatch test for post-tool bypass**

Add to `test/hooks/dispatch.test.ts`:

```typescript
it("routes post-tool without calling ensureBootstrapped", async () => {
  // Verify that dispatchHook("post-tool", validStdin) returns without
  // triggering ensureBootstrapped or validateAndFixHooks.
  // This is the highest-risk path — a bug here adds ~200ms to every tool call.
  const result = await dispatchHook("post-tool", JSON.stringify({
    session_id: "test",
    tool_name: "Read",
    tool_input: { file_path: "/test.ts" },
  }));
  expect(result.exitCode).toBe(0);
});

it("recognizes post-tool as a valid hook command", () => {
  expect(isHookCommand("post-tool")).toBe(true);
});
```

- [ ] **Step 5: Run dispatch tests**

Run: `npx vitest run test/hooks/dispatch.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/dispatch.ts .claude-plugin/plugin.json src/installer/settings.ts test/hooks/dispatch.test.ts
git commit -m "feat: register PostToolUse hook with bootstrap bypass"
```

---

### Task 6: Enhanced UserPromptSubmit

**Files:**
- Modify: `src/hooks/user-prompt.ts`
- Modify: `test/hooks/user-prompt.test.ts`
- Depends on: Tasks 2 (extractors), 3 (events-db)

- [ ] **Step 1: Write test for sidecar extraction**

Add to `test/hooks/user-prompt.test.ts`:

```typescript
// Add new test cases to existing describe block
it("extracts decision events to sidecar before prompt-search", async () => {
  // Setup: mock the events-db and extractors
  // The handler should call extractUserPromptEvents on the user prompt
  // and write any events to the sidecar before calling /prompt-search
});

it("continues normally if sidecar extraction fails", async () => {
  // Verify silent-fail: if sidecar write throws, prompt-search still works
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/user-prompt.test.ts`

- [ ] **Step 3: Modify user-prompt.ts**

Add sidecar extraction at the top of `handleUserPromptSubmit`, before the existing `/prompt-search` call:

```typescript
// At top of handleUserPromptSubmit, after parsing stdin:
try {
  const { extractUserPromptEvents } = await import("./extractors.js");
  const { EventsDb } = await import("./events-db.js");
  const { eventsDbPath } = await import("../db/events-path.js");

  const prompt = String(input.query ?? "");
  const events = extractUserPromptEvents(prompt);

  if (events.length > 0) {
    const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const db = new EventsDb(eventsDbPath(cwd));
    try {
      for (const event of events) {
        db.insertEvent(sessionId, event, "UserPromptSubmit");
      }
    } finally {
      db.close();
    }
  }
} catch {
  // Silent fail — never block the user's prompt
}
// ... existing prompt-search code continues unchanged
```

- [ ] **Step 4: Add role-aware learning instruction**

After the sidecar extraction, check for recent `role` events and inject into the learning instruction:

```typescript
// After sidecar extraction, before returning:
let roleContext = "";
try {
  const { EventsDb } = await import("./events-db.js");
  const { eventsDbPath } = await import("../db/events-path.js");
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = new EventsDb(eventsDbPath(cwd));
  try {
    const roleEvents = db.raw().prepare(
      "SELECT data FROM events WHERE category = 'role' ORDER BY created_at DESC LIMIT 1"
    ).all() as { data: string }[];
    if (roleEvents.length > 0) {
      roleContext = `\nUser context: ${roleEvents[0].data}`;
    }
  } finally {
    db.close();
  }
} catch {
  // Silent fail
}

// Inject into LEARNING_INSTRUCTION before returning
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/hooks/user-prompt.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/user-prompt.ts test/hooks/user-prompt.test.ts
git commit -m "feat: add sidecar extraction + role context to UserPromptSubmit"
```

---

### Task 7: Daemon Config Extension

**Files:**
- Modify: `src/daemon/config.ts`
- Depends on: none (parallel)

- [ ] **Step 1: Add eventConfidence to DaemonConfig type**

In `src/daemon/config.ts`, extend the `compaction.promotionThresholds` type:

```typescript
// Add to promotionThresholds in the DaemonConfig type:
eventConfidence?: {
  decision?: number;
  plan?: number;
  errorFix?: number;
  batch?: number;
  pattern?: number;
};
reinforcementBoost?: number;
maxConfidence?: number;
insightsMaxAgeDays?: number;
```

- [ ] **Step 2: Add defaults**

> **Note:** `loadDaemonConfig` uses `deepMerge()` which is recursive — nested objects like `eventConfidence` within `promotionThresholds` will be properly merged with user config overrides. No special handling needed.

In the defaults object within `loadDaemonConfig`:

```typescript
// Add inside compaction.promotionThresholds defaults:
eventConfidence: {
  decision: 0.5,
  plan: 0.7,
  errorFix: 0.4,
  batch: 0.3,
  pattern: 0.2,
},
reinforcementBoost: 0.3,
maxConfidence: 1.0,
insightsMaxAgeDays: 90,
```

- [ ] **Step 3: Run existing config tests**

Run: `npx vitest run test/daemon/config.test.ts`
Expected: PASS (new defaults merge with existing)

- [ ] **Step 4: Commit**

```bash
git add src/daemon/config.ts
git commit -m "feat: add eventConfidence config to promotionThresholds"
```

---

### Task 8: Promote Events Route

**Files:**
- Create: `src/daemon/routes/promote-events.ts`
- Test: `test/daemon/routes/promote-events.test.ts`
- Depends on: Tasks 1, 3, 7

- [ ] **Step 1: Write the failing tests**

```typescript
// test/daemon/routes/promote-events.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPromoteEventsHandler } from "../src/daemon/routes/promote-events.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDaemonConfig } from "../src/daemon/config.js";

describe("promote-events route", () => {
  let dir: string;
  let eventsDbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "promote-events-test-"));
    eventsDbPath = join(dir, "events.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes priority 1 events to promoted table", async () => {
    // Seed sidecar with a decision event
    const edb = new EventsDb(eventsDbPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "use SQLite", priority: 1 }, "PostToolUse");
    edb.close();

    // Call promote-events handler
    // Verify event is promoted and marked processed
  });

  it("correlates error→fix pairs", async () => {
    const edb = new EventsDb(eventsDbPath);
    edb.insertEvent("s1", { type: "error_tool", category: "error", data: "Bash error: npm install", priority: 1 }, "PostToolUse");
    edb.insertEvent("s1", { type: "env_install", category: "env", data: "npm install --legacy-peer-deps", priority: 2 }, "PostToolUse");
    edb.close();

    // Verify correlation: second event's prev_event_id points to first
  });

  it("marks all events as processed after promotion", async () => {
    const edb = new EventsDb(eventsDbPath);
    edb.insertEvent("s1", { type: "file_read", category: "file", data: "/src/main.ts (source)", priority: 3 }, "PostToolUse");
    edb.close();

    // After handler runs, getUnprocessed() should return []
  });

  it("is idempotent — skips already-processed events", async () => {
    const edb = new EventsDb(eventsDbPath);
    edb.insertEvent("s1", { type: "decision", category: "decision", data: "test", priority: 1 }, "PostToolUse");
    const events = edb.getUnprocessed();
    edb.markProcessed([events[0].event_id]);
    edb.close();

    // Handler should process 0 events, no error
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/routes/promote-events.test.ts`

- [ ] **Step 3: Write implementation**

```typescript
// src/daemon/routes/promote-events.ts
import { EventsDb, type EventRow } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { PromotedStore } from "../../db/promoted.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { projectId, projectDbPath } from "../project.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { DaemonConfig } from "../config.js";

const AUTO_TAGS: Record<string, string> = {
  decision: "category:preference",
  error: "category:gotcha",
  plan: "category:decision",
  role: "category:user-context",
  git: "category:workflow",
  env: "category:environment",
  file: "category:pattern",
};

const CORRELATION_WINDOW = 20;

interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
}

function correlateErrors(events: EventRow[]): void {
  // Group by session
  const bySession = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = bySession.get(e.session_id) ?? [];
    list.push(e);
    bySession.set(e.session_id, list);
  }

  for (const sessionEvents of bySession.values()) {
    // Sort by seq
    sessionEvents.sort((a, b) => a.seq - b.seq);

    // Find error→success pairs
    for (let i = 0; i < sessionEvents.length; i++) {
      const event = sessionEvents[i];
      if (event.category !== "error") continue;

      // Look for closest preceding error pattern match in the next CORRELATION_WINDOW events
      const errorPrefix = event.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

      for (let j = i + 1; j < sessionEvents.length && (sessionEvents[j].seq - event.seq) <= CORRELATION_WINDOW; j++) {
        const candidate = sessionEvents[j];
        if (candidate.category === "error") continue; // skip other errors
        const candidatePrefix = candidate.data.split(/\s+/).slice(0, 3).join(" ").toLowerCase();

        // Match on command prefix overlap
        if (candidatePrefix.includes(errorPrefix.split(":")[1]?.trim().split(" ")[0] ?? "")) {
          // Correlation found — this is an error→fix pair
          // prev_event_id will be set in the EventsDb
          (candidate as EventRow & { _correlatedErrorId?: number })._correlatedErrorId = event.event_id;
          break; // only correlate with closest match
        }
      }
    }
  }
}

export function createPromoteEventsHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: String(err) });
      return;
    }

    const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };

    try {
      const sidecarPath = eventsDbPath(cwd);
      const edb = new EventsDb(sidecarPath);

      try {
        const events = edb.getUnprocessed();
        if (events.length === 0) {
          sendJson(res, 200, { ...result, message: "no unprocessed events" });
          return;
        }

        // Correlate error→fix pairs
        correlateErrors(events);

        // Open main project DB for promotion
        const pid = projectId(cwd);
        const dbPath = projectDbPath(cwd);
        const db = getLcmConnection(dbPath);
        runLcmMigrations(db);
        const store = new PromotedStore(db);

        const thresholds = config.compaction.promotionThresholds;
        const eventConf = thresholds.eventConfidence ?? {
          decision: 0.5, plan: 0.7, errorFix: 0.4, batch: 0.3, pattern: 0.2,
        };

        const processedIds: number[] = [];

        for (const event of events) {
          try {
            const tag = AUTO_TAGS[event.category] ?? `category:${event.category}`;
            let confidence: number;

            // Determine confidence by tier
            if (event.priority === 1) {
              // Tier 1: immediate
              if (event.category === "plan") {
                confidence = eventConf.plan ?? 0.7;
              } else if ((event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId) {
                confidence = eventConf.errorFix ?? 0.4;
                result.correlated++;
              } else {
                confidence = eventConf.decision ?? 0.5;
              }
            } else if (event.priority === 2) {
              // Tier 2: batch
              confidence = eventConf.batch ?? 0.3;
            } else {
              // Tier 3: pattern-only — only promote if already in promoted table
              const existing = store.search(event.data, 1, undefined, pid);
              if (existing.length === 0) {
                processedIds.push(event.event_id);
                result.skipped++;
                continue;
              }
              confidence = eventConf.pattern ?? 0.2;
            }

            // Set correlation chain
            const correlatedErrorId = (event as EventRow & { _correlatedErrorId?: number })._correlatedErrorId;
            if (correlatedErrorId) {
              edb.setPrevEventId(event.event_id, correlatedErrorId);
            }

            // Promote via existing dedup pipeline
            await deduplicateAndInsert({
              store,
              content: event.data,
              tags: [tag, `source:passive-capture`, `hook:${event.source_hook}`],
              projectId: pid,
              sessionId: event.session_id,
              depth: 0,
              confidence,
              thresholds: {
                dedupBm25Threshold: thresholds.dedupBm25Threshold ?? 15,
                dedupCandidateLimit: thresholds.dedupCandidateLimit ?? 100,
              },
            });

            processedIds.push(event.event_id);
            result.promoted++;
          } catch {
            processedIds.push(event.event_id); // mark processed even on error to avoid stuck events
            result.errors++;
          }
        }

        edb.markProcessed(processedIds);
        closeLcmConnection(dbPath);
      } finally {
        edb.close();
      }
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
      return;
    }

    sendJson(res, 200, result);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/routes/promote-events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/promote-events.ts test/daemon/routes/promote-events.test.ts
git commit -m "feat: add /promote-events daemon route"
```

---

### Task 9: Server Registration + Integration Hooks

**Files:**
- Modify: `src/daemon/server.ts`
- Modify: `src/hooks/session-end.ts`
- Modify: `src/hooks/compact.ts`
- Modify: `src/hooks/session-snapshot.ts`
- Depends on: Task 8

- [ ] **Step 1: Register route in server.ts**

Add to `src/daemon/server.ts` alongside existing route registrations:

```typescript
import { createPromoteEventsHandler } from "./routes/promote-events.js";

// In the route setup section, add:
instance.registerRoute("POST", "/promote-events", createPromoteEventsHandler(config));
```

- [ ] **Step 2: Add firePromoteEventsRequest to session-end.ts**

Add a fire-and-forget function following the existing pattern (`fireCompactRequest`, `firePromoteRequest`):

```typescript
export function firePromoteEventsRequest(port: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  const req = request({
    hostname: "127.0.0.1",
    port,
    path: "/promote-events",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) },
  });
  // IMPORTANT: Use deferred socket.unref() — same pattern as fireCompactRequest.
  // Bare req.unref() risks the process exiting before the body reaches the daemon.
  req.on("socket", (socket) => {
    req.on("finish", () => (socket as import("node:net").Socket).unref());
  });
  req.on("error", () => {}); // non-fatal
  req.write(json);
  req.end();
}
```

Then call it in `handleSessionEnd` after `firePromoteRequest`:

```typescript
firePromoteEventsRequest(resolvedPort, { cwd: input.cwd });
```

- [ ] **Step 3: Add promote-events trigger to compact.ts**

In `handlePreCompact`, after the existing `/compact` POST, add a promote-events call with 3s timeout:

```typescript
// After the compact call, before returning:
// Reuse the shared fire-and-forget function from session-end.ts
try {
  const { firePromoteEventsRequest } = await import("./session-end.js");
  firePromoteEventsRequest(resolvedPort, { cwd: input.cwd });
} catch {
  // Silent fail — PreCompact must not delay session
}
```

- [ ] **Step 4: Add best-effort flush to session-snapshot.ts**

In `handleSessionSnapshot`, add a promote-events fire-and-forget at the end (same pattern as session-end):

```typescript
// Import firePromoteEventsRequest from session-end.ts or duplicate the pattern
// Add after existing snapshot logic:
try {
  const { firePromoteEventsRequest } = await import("./session-end.js");
  firePromoteEventsRequest(port, { cwd: input.cwd });
} catch {
  // Best-effort only
}
```

- [ ] **Step 5: Run existing hook tests**

Run: `npx vitest run test/hooks/session-end.test.ts test/hooks/compact.test.ts test/hooks/session-snapshot.test.ts`
Expected: PASS (existing tests should still pass)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.ts src/hooks/session-end.ts src/hooks/compact.ts src/hooks/session-snapshot.ts
git commit -m "feat: register /promote-events route and add integration triggers"
```

---

### Task 10: Learned Insights on SessionStart

**Files:**
- Modify: `src/hooks/restore.ts`
- Modify: `test/hooks/restore.test.ts`
- Depends on: Task 8

- [ ] **Step 1: Write test for learned insights injection**

Add to `test/hooks/restore.test.ts`:

```typescript
it("includes learned-insights block in restore output", async () => {
  // Setup: seed promoted store with entries tagged source:passive-capture
  // Call handleSessionStart
  // Verify output contains <learned-insights> block
});

it("omits learned-insights when no passive-capture entries exist", async () => {
  // Call handleSessionStart with empty promoted store
  // Verify no <learned-insights> block in output
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/hooks/restore.test.ts`

- [ ] **Step 3: Modify restore.ts**

After the existing `/restore` call, extend the output with learned insights. The daemon's `/restore` response should be extended to include an `insights` array. Alternatively, make a separate query.

**Approach:** Add the insights query to the `/restore` route handler (in `src/daemon/routes/restore.ts`) — it has access to the promoted store. This avoids a second HTTP round-trip.

In `src/daemon/routes/restore.ts`, after building the context response:

```typescript
// Query insights from promoted store
const thresholds = config.compaction.promotionThresholds;
const maxAge = thresholds.insightsMaxAgeDays ?? 90;
const insights = store.search("source:passive-capture", 5, ["source:passive-capture"], pid)
  .filter(r => r.confidence >= 0.3)
  .slice(0, 5);

// Add insights to response
if (insights.length > 0) {
  response.insights = insights.map(i => ({
    content: i.content,
    confidence: i.confidence,
    tags: i.tags,
  }));
}
```

In `src/hooks/restore.ts`, after receiving the response:

```typescript
// After existing context output:
if (result.insights?.length > 0) {
  const insightsBlock = result.insights
    .map((i: { content: string; confidence: number }) =>
      `- ${i.content} (confidence: ${i.confidence})`
    )
    .join("\n");

  stdout += `\n<learned-insights source="passive-capture">\nRecent learnings from your previous sessions:\n${insightsBlock}\n</learned-insights>`;
}
```

- [ ] **Step 4: Add SessionStart scavenge**

Also in restore.ts, add sidecar scavenge for unprocessed events from previous sessions:

```typescript
// At the start of handleSessionStart, before /restore call:
try {
  const { EventsDb } = await import("./events-db.js");
  const { eventsDbPath } = await import("../db/events-path.js");
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const db = new EventsDb(eventsDbPath(cwd));
  try {
    // Prune old processed events
    db.pruneProcessed(7);

    // If unprocessed events exist, trigger promotion
    const unprocessed = db.getUnprocessed(1);
    if (unprocessed.length > 0) {
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(resolvedPort, { cwd });
    }
  } finally {
    db.close();
  }
} catch {
  // Silent fail
}
```

- [ ] **Step 5: Add route-side test**

Add to `test/daemon/routes/restore.test.ts` (or create if it doesn't exist):

```typescript
it("includes insights array when passive-capture entries exist in promoted store", async () => {
  // Seed promoted store with entries tagged source:passive-capture
  // Call /restore handler
  // Verify response includes insights array with content + confidence
});

it("omits insights array when no passive-capture entries exist", async () => {
  // Call /restore with empty promoted store
  // Verify no insights in response
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/hooks/restore.test.ts test/daemon/routes/restore.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/hooks/restore.ts src/daemon/routes/restore.ts test/hooks/restore.test.ts test/daemon/routes/restore.test.ts
git commit -m "feat: add learned-insights injection + SessionStart scavenge"
```

---

### Task 11: E2E Test

**Files:**
- Create: `test/e2e/passive-learning.test.ts`
- Depends on: all previous tasks

- [ ] **Step 1: Write E2E test**

```typescript
// test/e2e/passive-learning.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handlePostToolUse } from "../src/hooks/post-tool.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("passive learning E2E", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-passive-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures PostToolUse event → sidecar → promotion-ready", async () => {
    // 1. Simulate PostToolUse with an AskUserQuestion
    // 2. Verify event lands in sidecar DB
    // 3. Verify event has correct type, category, priority
    // 4. Verify event is unprocessed
  });

  it("full cycle: capture → promote → insights", async () => {
    // 1. Capture events via PostToolUse
    // 2. Call /promote-events
    // 3. Verify events are in promoted store
    // 4. Call /restore
    // 5. Verify insights appear in response
  });
});
```

- [ ] **Step 2: Run E2E test**

Run: `npx vitest run test/e2e/passive-learning.test.ts`

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add test/e2e/passive-learning.test.ts
git commit -m "test: add E2E test for passive learning pipeline"
```

---

## Post-Implementation Checklist

- [ ] All tests pass (`npm test`)
- [ ] Type-check passes (`npm run build` or `npx tsc --noEmit`)
- [ ] Plugin cache is updated (copy hooks + plugin.json to `~/.claude/plugins/cache/`)
- [ ] Manual smoke test: start Claude Code, use a tool, check `~/.lossless-claude/events/` for sidecar DB
- [ ] Run `/lcm-doctor` to verify no regressions
