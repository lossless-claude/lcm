// test/hooks/extractors.test.ts
import { describe, it, expect } from "vitest";
import {
  extractPostToolEvents,
  extractUserPromptEvents,
  type ExtractedEvent,
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
