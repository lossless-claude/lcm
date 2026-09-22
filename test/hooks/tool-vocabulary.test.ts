// test/hooks/tool-vocabulary.test.ts
import { describe, expect, it } from "vitest";
import { translateToolCall, type ToolVocabulary } from "../../src/hooks/tool-vocabulary.js";

/**
 * The seam between a harness's tool ids and the passive-learning extractor.
 * Harnesses own their tables; this module owns what a table means.
 */

const vocabulary: ToolVocabulary = {
  exec_command: { canonical: "Bash" },
  apply_patch: {
    canonical: "Edit",
    input: (call) => ({ ...call.input, file_paths: ["src/a.ts"] }),
  },
  update_plan: {
    canonical: "TaskUpdate",
    // Declines when the harness payload carried no current step: a row with empty
    // data is worse than no row.
    input: (call) => (call.input.step ? { subject: call.input.step, status: "in_progress" } : undefined),
  },
  write_stdin: { silent: "transport for an existing exec session, not an act" },
};

describe("translateToolCall", () => {
  it("maps a listed id onto the canonical name, leaving a payload the extractor already reads untouched", () => {
    const translated = translateToolCall(vocabulary, {
      toolName: "exec_command",
      input: { command: "git commit -m x" },
    });
    expect(translated).toEqual({ tool_name: "Bash", tool_input: { command: "git commit -m x" } });
  });

  it("lets a harness rewrite the payload into the fields the extractor reads", () => {
    const translated = translateToolCall(vocabulary, {
      toolName: "apply_patch",
      input: { command: "*** Update File: src/a.ts" },
    });
    expect(translated).toEqual({
      tool_name: "Edit",
      tool_input: { command: "*** Update File: src/a.ts", file_paths: ["src/a.ts"] },
    });
  });

  it("passes a call through unmapped when its payload carried nothing usable, so a failure still reaches the extractor", () => {
    const declined = translateToolCall(vocabulary, { toolName: "update_plan", input: { plan: [] } });
    expect(declined).toEqual({ tool_name: "update_plan", tool_input: { plan: [] } });
    expect(translateToolCall(vocabulary, { toolName: "update_plan", input: { step: "Wire the seam" } }))
      .toEqual({ tool_name: "TaskUpdate", tool_input: { subject: "Wire the seam", status: "in_progress" } });
  });

  it("passes an id the harness declares silent through unmapped, without dropping it", () => {
    expect(translateToolCall(vocabulary, { toolName: "write_stdin", input: { session_id: "1" } }))
      .toEqual({ tool_name: "write_stdin", tool_input: { session_id: "1" } });
  });

  it("passes an id the harness has no opinion about straight through, so names the extractor already knows still reach it", () => {
    expect(translateToolCall(vocabulary, { toolName: "mcp__github__create_pr", input: { title: "x" } }))
      .toEqual({ tool_name: "mcp__github__create_pr", tool_input: { title: "x" } });
  });
});