import { describe, expect, it } from "vitest";
import { parseCodexTranscriptRecord } from "../src/codex-transcript.js";

const record = (payload: unknown, type = "response_item") => JSON.stringify({ type, payload });

describe("Codex role tagging", () => {
  it("records a function call by name, never by its arguments", () => {
    const { message } = parseCodexTranscriptRecord(record({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "rm -rf /tmp/x" }),
    }));
    expect(message).toMatchObject({ role: "tool", content: "exec_command" });
    expect(message?.content).not.toContain("rm -rf");
  });

  it("records a custom tool call by name, never by its input", () => {
    const { message } = parseCodexTranscriptRecord(record({
      type: "custom_tool_call",
      name: "exec",
      input: "const r = await tools.exec_command({ cmd: 'sed -n 1,260p secret.ts' })",
    }));
    expect(message).toMatchObject({ role: "tool", content: "exec" });
    expect(message?.content).not.toContain("secret.ts");
  });

  it("keeps a tool's output under the tool role", () => {
    const { message } = parseCodexTranscriptRecord(record({
      type: "function_call_output",
      output: "Process exited with code 1\nattempt to write a readonly database",
    }));
    expect(message).toEqual({
      role: "tool",
      content: "Process exited with code 1\nattempt to write a readonly database",
      tokenCount: expect.any(Number),
    });
  });

  it("keeps a custom tool's output under the tool role", () => {
    const { message } = parseCodexTranscriptRecord(record({
      type: "custom_tool_call_output",
      output: "Script completed",
    }));
    expect(message).toMatchObject({ role: "tool", content: "Script completed" });
  });

  it("leaves a user message human", () => {
    const { message } = parseCodexTranscriptRecord(record({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "roda os testes" }],
    }));
    expect(message).toMatchObject({ role: "user", content: "roda os testes" });
  });

  it("drops an empty tool output rather than storing a blank row", () => {
    expect(parseCodexTranscriptRecord(record({ type: "function_call_output", output: "   " }))).toEqual({});
  });

  it("still ignores the UI projection events that would duplicate a turn", () => {
    expect(parseCodexTranscriptRecord(record({ type: "user_message", message: "oi" }, "event_msg"))).toEqual({});
  });
});
