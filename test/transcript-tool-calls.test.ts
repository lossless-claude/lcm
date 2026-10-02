import { describe, expect, it } from "vitest";
import { parseClaudeTranscriptRecord, estimateTokens } from "../src/transcript.js";
import { parseCodexTranscriptRecord } from "../src/codex-transcript.js";
import { parseOmpTranscriptRecord, selectOmpLiveSegments } from "../src/omp-transcript.js";

const parsers = {
  claude(name: string, input: unknown) {
    return parseClaudeTranscriptRecord(JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", id: "call", name, input }] } }));
  },
  codex(name: string, input: unknown) {
    return parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call", name, arguments: JSON.stringify(input) } }));
  },
  omp(name: string, input: unknown) {
    return parseOmpTranscriptRecord(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name, arguments: input }] } }));
  },
};
const names = {
  claude: ["Bash", "Write", "Read", "Grep", "Glob", "Agent"],
  codex: ["exec_command", "Write", "Read", "Grep", "Glob", "Agent"],
  omp: ["bash", "write", "read", "grep", "glob", "agent"],
};

describe.each(["claude", "codex", "omp"] as const)("%s tool-call structure beside messages", (client) => {
  const parse = parsers[client];
  const [shell, write, read, grep, glob, agent] = names[client];
  it.each([
    [shell, { command: "printf example", cmd: "printf example" }, "printf example"],
    [write, { file_path: "a.ts", path: "a.ts", content: "PRIVATE FILE BODY" }, '{"paths":["a.ts"]}'],
    [read, { file_path: "a.ts", offset: 2, limit: 4, unused: "private" }, '{"file_path":"a.ts","offset":2,"limit":4}'],
    [grep, { path: "src", pattern: "needle", "-n": true, "-A": 2 }, '{"path":"src","pattern":"needle","-n":true,"-A":2}'],
    [glob, { path: "src", pattern: "*.ts" }, '{"path":"src","pattern":"*.ts"}'],
    [agent, { subagent_type: "Explore", description: "inspect", prompt: "PRIVATE PROMPT" }, '{"subagent_type":"Explore","description":"inspect"}'],
    ["mcp__service__query", { query: "example", nested: { value: 3 } }, '{"query":"example","nested":{"value":3}}'],
    ["unrecognized", { secret: "PRIVATE UNKNOWN INPUT" }, undefined],
  ])("keeps only the allowed input for %s", (name, input, expected) => {
    const record = parse(name, input);
    expect(record.toolCalls).toHaveLength(1);
    expect(record.toolCalls![0]).toMatchObject({ callId: "call", name, outcome: "unknown" });
    expect(record.toolCalls![0].input).toBe(expected);
    if (name === write) expect(record.toolCalls![0].inputBytes).toBe(Buffer.byteLength(JSON.stringify(input)));
    const expectedMessage = { role: "tool", content: name, tokenCount: estimateTokens(name) };
    expect(record.message).toEqual(client === "omp" ? [expectedMessage] : expectedMessage);
  });
});

it.each(["Edit", "MultiEdit", "NotebookEdit"])("Claude %s never keeps replacement bodies", name => {
  const input = { file_path: "a.ts", notebook_path: "a.ipynb", edits: [{ old_string: "PRIVATE OLD", new_string: "PRIVATE NEW" }] };
  const call = parsers.claude(name, input).toolCalls?.[0];
  expect(call?.input).toBe('{"paths":["a.ts","a.ipynb"]}');
  expect(call?.inputBytes).toBe(Buffer.byteLength(JSON.stringify(input)));
});

it("Codex custom apply_patch keeps paths and byte size, including a move, without patch text", () => {
  const input = "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-PRIVATE OLD\n+PRIVATE NEW\n*** Add File: c.ts\n+PRIVATE BODY\n*** Delete File: d.ts\n*** End Patch";
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input } }));
  expect(record.toolCalls?.[0]).toMatchObject({ input: '{"paths":["a.ts","b.ts","c.ts","d.ts"]}', inputBytes: Buffer.byteLength(input) });
});

const claudeResult = (output: string, is_error?: boolean) => parseClaudeTranscriptRecord(JSON.stringify({
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: output, ...(is_error === undefined ? {} : { is_error }) }] },
})).toolCalls?.[0];
it.each([
  ["ok", false, "succeeded", null],
  ["Exit code 7\nfailed", true, "failed", 7],
  ["The user doesn't want to proceed with this tool use.", true, "denied", null],
  ["Permission denied by hook", true, "unknown", null],
  ["File does not exist.", true, "unknown", null],
  ["PreToolUse:Read hook error: refused", true, "blocked", null],
  ["Permission for this action was denied by the Claude Code auto mode classifier.", true, "blocked", null],
  ["The server-side auto mode classifier gave no verdict (error)", true, "blocked", null],
  ["<tool_use_error>Blocked: standalone sleep</tool_use_error>", true, "blocked", null],
  ["[Request interrupted by user for tool use]", true, "interrupted", null],
  ["output with no status", undefined, "unknown", null],
])("Claude classifies %s independently of its error flag", (output, flag, outcome, exitCode) => {
  expect(claudeResult(output, flag)).toMatchObject({ callId: "call", outcome, exitCode, harnessError: flag ?? null });
});

it.each([
  ["Process exited with code 0\nFinal output:\nok", "succeeded", 0],
  ["Process exited with code 2\nFinal output:\nfailed", "failed", 2],
  ["exec_command failed: User rejected exec command", "denied", null],
  ["exec_command failed: command rejected by policy", "blocked", null],
  ["aborted by user", "interrupted", null],
  ["unclassified output", "unknown", null],
])("Codex classifies exposed output: %s", (output, outcome, exitCode) => {
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome, exitCode, harnessError: null });
});

it.each([
  ["ok", false, undefined, "succeeded", null],
  ["Command exited with code 3", true, undefined, "failed", 3],
  ["guard error", true, undefined, "unknown", null],
  ["output without status", undefined, undefined, "unknown", null],
  ["Command aborted", true, {}, "interrupted", null],
])("OMP classifies exposed result: %s", (text, isError, details, outcome, exitCode) => {
  const record = parseOmpTranscriptRecord(JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text }], isError, details } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome, exitCode, harnessError: isError ?? null });
});

it("OMP excludes calls from abandoned tree branches", () => {
  const record = (id: string, parentId: string | null, name: string) => ({
    ...parsers.omp(name, { command: id }), node: { id, parentId },
  });
  const selected = selectOmpLiveSegments([record("root", null, "bash"), record("abandoned", "root", "write"), record("live", "root", "read")]);
  expect(selected.toolCalls.map(call => call.name)).toEqual(["bash", "read"]);
});

it.each(["claude", "codex", "omp"] as const)("keeps a %s result's status even when it contributes no message", client => {
  const record = client === "claude" ? parseClaudeTranscriptRecord(JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "", is_error: false }] } }))
    : client === "codex" ? parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: [], is_error: true } }))
    : parseOmpTranscriptRecord(JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call", content: [], isError: false } }));
  expect(record.message).toBeUndefined();
  expect(record.toolCalls?.[0]).toMatchObject({ callId: "call", outcome: client === "codex" ? "unknown" : "succeeded", harnessError: client === "codex" });
});

// Shapes emitted by OMP's agent-loop, approval wrapper, and Bash executor.
it.each([
  ["Blocked: call a dedicated tool", {}, "blocked"],
  ['Tool "bash" is blocked by user policy.', {}, "blocked"],
  ["Tool execution was blocked by a hook", {}, "blocked"],
  ["Tool call denied by user: bash", {}, "denied"],
  ["Operation aborted", {}, "interrupted"],
  ["[Command cancelled]\npartial output", {}, "interrupted"],
  ["partial output\n\n[Command aborted]", {}, "interrupted"],
  ["Tool execution was aborted.", { __synthetic: true, source: "assistant_stop_aborted", executed: false }, "interrupted"],
  ["Stream error", { __synthetic: true, source: "assistant_stop_error", executed: false }, "unknown"],
  ["Skipped", { __synthetic: true, source: "assistant_stop_skipped", executed: false }, "unknown"],
  ["Interrupted", { __interrupted: true, source: "interrupt_skipped", execution: "started" }, "interrupted"],
  ["Timed out", { timedOut: true }, "failed"],
  ["failed", { exitCode: 4 }, "failed"],
  ["generic failure with no execution evidence", {}, "unknown"],
])("OMP exposes %s", (text, details, outcome) => {
  const record = parseOmpTranscriptRecord(JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text }], isError: true, details } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome, harnessError: true });
});

it("Codex interruption follows the wall-time line in exec output", () => {
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "Wall time: 4.0 seconds\naborted by user" } }));
  expect(record.toolCalls?.[0].outcome).toBe("interrupted");
});

it("Codex reads outcome text from structured text output blocks", () => {
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: [{ type: "text", text: "Process exited with code 6" }] } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome: "failed", exitCode: 6 });
});

it("a Claude error without block evidence is a block only if the call was a shell command", () => {
  expect(claudeResult("This guard refuses the command", true)).toMatchObject({ outcome: "unknown", shellOutcome: "blocked" });
  expect(claudeResult("Exit code 1\nfailed", true)).not.toHaveProperty("shellOutcome");
  expect(claudeResult("PreToolUse:Bash hook error: refused", true)).not.toHaveProperty("shellOutcome");
});

it("a Claude exit code counts only on the result's first line", () => {
  expect(claudeResult("built\nExit code 1 appears in the build log", false)).toMatchObject({ outcome: "succeeded", exitCode: null });
  expect(claudeResult("Exit code 2\nboom", true)).toMatchObject({ outcome: "failed", exitCode: 2 });
});

it("known successful exit status wins over refusal-like text printed by a command", () => {
  expect(claudeResult("The user doesn't want to proceed", false)?.outcome).toBe("succeeded");
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "Process exited with code 0\nFinal output:\nUser rejected exec command" } }));
  expect(record.toolCalls?.[0].outcome).toBe("succeeded");
});

it("OMP task batches retain only agent types and descriptions", () => {
  const record = parsers.omp("task", { agent: "explore", tasks: [{ id: "scan", description: "inspect", prompt: "PRIVATE PROMPT" }] });
  expect(record.toolCalls?.[0].input).toBe('{"agent":"explore","tasks":[{"description":"inspect"}]}');
});

it("Codex JSON apply_patch arguments keep only paths", () => {
  const record = parsers.codex("apply_patch", { patch: "*** Begin Patch\n*** Add File: a.ts\n+PRIVATE BODY\n*** End Patch" });
  expect(record.toolCalls?.[0].input).toBe('{"paths":["a.ts"]}');
});

it.each(["claude", "codex", "omp"] as const)("collects paths inside %s multi-file edits without replacement text", client => {
  const record = parsers[client](client === "omp" ? "edit" : "MultiEdit", {
    edits: [{ path: "a.ts", content: "PRIVATE A" }, { file_path: "b.ts", new_string: "PRIVATE B" }],
  });
  expect(record.toolCalls?.[0].input).toBe('{"paths":["a.ts","b.ts"]}');
});

it("OMP command status wins over cancellation-like stdout", () => {
  const record = parseOmpTranscriptRecord(JSON.stringify({ type: "message", message: {
    role: "toolResult", toolCallId: "call", isError: false,
    content: [{ type: "text", text: "Command aborted" }], details: { exitCode: 0 },
  } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome: "succeeded", exitCode: 0 });
});

it("Codex apply_patch exposes success without an exit code", () => {
  const record = parseCodexTranscriptRecord(JSON.stringify({ type: "response_item", payload: {
    type: "custom_tool_call_output", call_id: "patch", output: "Success. Updated the following files:\nM a.ts\n",
  } }));
  expect(record.toolCalls?.[0]).toMatchObject({ outcome: "succeeded", exitCode: null, harnessError: null });
});
