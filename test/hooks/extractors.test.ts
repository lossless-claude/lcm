// test/hooks/extractors.test.ts
import { describe, it, expect } from "vitest";
import {
  EXTRACTOR_TOOL_NAMES,
  extractPostToolEvents,
  extractUserPromptEvents,
  normalizePromptWithChannels,
  type ExtractedEvent,
  type PostToolInput,
} from "../../src/hooks/extractors.js";

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

  it.each(["Read", "Edit", "Write"])("does not emit a file event for %s without a path", (tool_name) => {
    expect(extractPostToolEvents({ tool_name, tool_input: {} })).toEqual([]);
    expect(extractPostToolEvents({ tool_name, tool_input: { file_paths: ["", "  "] } })).toEqual([]);
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

describe("extractPostToolEvents — PostToolUseFailure", () => {
  it("extracts a Bash failure with the exit-code headline", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test --silent" },
      error: "Exit code 1\nError: Cannot find module 'express'",
    });
    expect(events).toEqual([expect.objectContaining({ type: "error_tool", category: "error", priority: 1 })]);
    expect(events[0].data).toBe("Bash error: npm test --silent — Exit code 1");
  });

  it("extracts a failure for a tool that normally has a success extractor", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Which db?" },
      error: "User cancelled",
    });
    expect(events).toEqual([expect.objectContaining({ type: "error_tool", data: "AskUserQuestion error — User cancelled" })]);
  });

  it("ignores interrupts — an abort is not a tool error", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "sleep 100" },
      error: "aborted",
      is_interrupt: true,
    });
    expect(events).toEqual([]);
  });

  it("drops a failure on a sensitive path, like the success path does", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Read",
      tool_input: { file_path: "/home/me/.ssh/id_rsa" },
      error: "EACCES: permission denied",
    });
    expect(events).toEqual([]);
  });

  it("strips the command and the headline when either leaks a sensitive path", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "cat .env" },
      error: "cat: .env: No such file",
    });
    expect(events[0].data).toBe("Bash error");
  });

  it("keeps the command prefix when nothing is sensitive", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm run build --silent" },
      error: "Exit code 2\nsomething broke",
    });
    expect(events[0].data).toBe("Bash error: npm run build — Exit code 2");
  });

  it("does not stringify a non-string error payload", () => {
    const events = extractPostToolEvents({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
      error: { message: "boom" } as unknown as string,
    });
    expect(events[0].data).toBe("Glob error");
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

describe("normalizePromptWithChannels", () => {
  it("strips channel XML and returns clean text", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="456" user="pedro" ts="1234">always use TypeScript</channel>';
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript");
    expect(fromChannel).toBe(true);
  });

  it("returns original text unchanged when no channel tag present", () => {
    const raw = "always use TypeScript";
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript");
    expect(fromChannel).toBe(false);
  });

  it("handles multi-line channel content", () => {
    const raw = '<channel source="telegram" chat_id="1">\nalways use TypeScript\nfor new files\n</channel>';
    const { text, fromChannel } = normalizePromptWithChannels(raw);
    expect(text).toBe("always use TypeScript\nfor new files");
    expect(fromChannel).toBe(true);
  });
});

describe("extractUserPromptEvents — Telegram channel wrapping", () => {
  it("extracts decision from channel-wrapped prompt", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="456" user="pedro" ts="1234">always use TypeScript for new files</channel>';
    const events = extractUserPromptEvents(raw);
    const decisions = events.filter(e => e.category === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      type: "user_decision",
      category: "decision",
      priority: 1,
    });
  });

  it("strips XML from stored data in decision events from Telegram", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="1" user="pedro" ts="1234">always use TypeScript for new files</channel>';
    const events = extractUserPromptEvents(raw);
    const decision = events.find(e => e.category === "decision");
    expect(decision).toBeDefined();
    expect(decision!.data).not.toContain("<channel");
    expect(decision!.data).toContain("always use TypeScript");
  });

  it("adds source:telegram tag to events extracted from channel messages", () => {
    const raw = '<channel source="telegram" chat_id="123" message_id="1" user="pedro" ts="1234">always use TypeScript</channel>';
    const events = extractUserPromptEvents(raw);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tags).toContain("source:telegram");
    }
  });

  it("does NOT add source:telegram tag for non-channel prompts", () => {
    const events = extractUserPromptEvents("always use TypeScript");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tags).toBeUndefined();
    }
  });
});

describe("harness-agnostic tool shapes", () => {
  it("records a GitHub write operation, and stays silent for its reads and searches", () => {
    const created = extractPostToolEvents({
      tool_name: "GitHub",
      tool_input: { op: "pr_create", repo: "acme/lcm", title: "Fix the OMP parser" },
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "github_pr_create", category: "git", priority: 2 });
    expect(created[0].data).toContain("Fix the OMP parser");

    for (const op of ["repo_view", "file_read", "search_prs", "search_code"]) {
      expect(extractPostToolEvents({ tool_name: "GitHub", tool_input: { op } })).toEqual([]);
    }
  });

  it("records a security scan when one is started, not when its status is polled", () => {
    const started = extractPostToolEvents({
      tool_name: "SecurityScan",
      tool_input: { action: "start", target_kind: "working_tree" },
    });
    expect(started).toEqual([
      { type: "security_scan", category: "security", data: "scan started (working_tree)", priority: 2 },
    ]);
    expect(extractPostToolEvents({ tool_name: "SecurityScan", tool_input: { action: "status" } })).toEqual([]);
  });

  it("records a written context note as its own content", () => {
    const events = extractPostToolEvents({
      tool_name: "ContextNote",
      tool_input: { text: "Postgres chosen over SQLite for the ledger table" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "context_note", category: "context", priority: 2 });
    expect(events[0].data).toContain("Postgres chosen over SQLite");
  });

  it("records a context change by kind", () => {
    expect(extractPostToolEvents({ tool_name: "ContextChange", tool_input: { kind: "rewind", detail: "abandoned the SQLite path" } }))
      .toEqual([{ type: "context_rewind", category: "context", data: "abandoned the SQLite path", priority: 2 }]);
    expect(extractPostToolEvents({ tool_name: "ContextChange", tool_input: { kind: "checkpoint", detail: "explore the parser" } }))
      .toEqual([{ type: "context_checkpoint", category: "context", data: "explore the parser", priority: 2 }]);
    expect(extractPostToolEvents({ tool_name: "ContextChange", tool_input: { kind: "reset" } }))
      .toEqual([{ type: "context_reset", category: "context", data: "fresh context requested", priority: 2 }]);
  });

  // Every name a harness may target must have a shape here. The fixture record is typed
  // by the exported name list, so adding a canonical name fails to compile until it has
  // a fixture, and this test fails unless the extractor has a case for it.
  it("has a shape for every canonical tool name", () => {
    const fixtures: Record<(typeof EXTRACTOR_TOOL_NAMES)[number], PostToolInput> = {
      AskUserQuestion: { tool_name: "AskUserQuestion", tool_input: { question: "Which store?" }, tool_response: "SQLite" },
      EnterPlanMode: { tool_name: "EnterPlanMode", tool_input: {} },
      ExitPlanMode: { tool_name: "ExitPlanMode", tool_input: {}, tool_response: "approved" },
      Bash: { tool_name: "Bash", tool_input: { command: "git commit -m x" } },
      Read: { tool_name: "Read", tool_input: { file_path: "src/a.ts" } },
      Edit: { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
      Write: { tool_name: "Write", tool_input: { file_path: "src/a.ts" } },
      Glob: { tool_name: "Glob", tool_input: { pattern: "src/**" } },
      Grep: { tool_name: "Grep", tool_input: { pattern: "needle" } },
      TaskCreate: { tool_name: "TaskCreate", tool_input: { subject: "wire the seam" } },
      TaskUpdate: { tool_name: "TaskUpdate", tool_input: { subject: "wire the seam", status: "in_progress" } },
      Agent: { tool_name: "Agent", tool_input: { description: "explore the parser" } },
      Skill: { tool_name: "Skill", tool_input: { skill: "lcm-memory" } },
      GitHub: { tool_name: "GitHub", tool_input: { op: "pr_create", title: "Fix the parser" } },
      SecurityScan: { tool_name: "SecurityScan", tool_input: { action: "start" } },
      ContextNote: { tool_name: "ContextNote", tool_input: { text: "Postgres for the ledger" } },
      ContextChange: { tool_name: "ContextChange", tool_input: { kind: "reset" } },
    };

    for (const name of EXTRACTOR_TOOL_NAMES) {
      expect(extractPostToolEvents(fixtures[name]), `no event for canonical tool ${name}`).not.toEqual([]);
    }
  });
});
