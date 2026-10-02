import type { ParsedMessage } from "./transcript.js";

export type ToolOutcome = "succeeded" | "failed" | "blocked" | "denied" | "interrupted" | "unknown";

/** Travels beside rows. The message reference never adds fields to parser output. */
export interface TranscriptToolCall {
  callId: string;
  name?: string;
  input?: string;
  inputBytes?: number;
  /** Only shell commands and MCP JSON have a byte budget. */
  inputLimit?: number;
  message?: ParsedMessage;
  outcome: ToolOutcome;
  harnessError: boolean | null;
  exitCode: number | null;
}

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try { return inputObject(JSON.parse(input)); } catch { return {}; }
  }
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

const INPUT_LIMIT_BYTES = 2048;
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "apply_patch"]);
const READ_FIELDS = new Set([
  "file_path", "path", "paths", "pattern", "glob", "include", "type", "offset", "limit",
  "start_line", "end_line", "line_start", "line_end", "head_limit", "output_mode",
  "multiline", "-n", "-i", "-A", "-B", "-C", "context", "case_sensitive",
]);

/** Select before scrubbing; file bodies and subagent prompts never enter stored input. */
export function transcriptToolInput(name: string, input: unknown): Pick<TranscriptToolCall, "input" | "inputBytes" | "inputLimit"> {
  const tool = name.replace(/^functions\./, "").toLowerCase();
  const object = inputObject(input);
  if (["bash", "exec", "exec_command", "shell", "shell_command"].includes(tool)) {
    const command = object.command ?? object.cmd;
    if (typeof command === "string") return { input: command, inputLimit: INPUT_LIMIT_BYTES };
    if (Array.isArray(command) && command.every(item => typeof item === "string")) return { input: JSON.stringify(command), inputLimit: INPUT_LIMIT_BYTES };
    return {};
  }
  if (WRITE_TOOLS.has(tool)) {
    const targets = [object, ...(Array.isArray(object.edits) ? object.edits.map(inputObject) : [])];
    const paths = targets.flatMap(target => [target.file_path, target.path, target.notebook_path])
      .filter((path): path is string => typeof path === "string");
    if (tool === "apply_patch") {
      const patch = object.patch ?? object.input ?? (typeof input === "string" ? input : undefined);
      if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) paths.push(match[1]);
    }
    const encoded = typeof input === "string" ? input : JSON.stringify(input ?? {});
    return { input: JSON.stringify({ paths: [...new Set(paths)] }), inputBytes: Buffer.byteLength(encoded) };
  }
  if (["read", "grep", "glob"].includes(tool)) {
    return { input: JSON.stringify(Object.fromEntries(Object.entries(object).filter(([field]) => READ_FIELDS.has(field)))) };
  }
  if (["agent", "task", "spawn_agent"].includes(tool)) {
    const metadata = Object.fromEntries(Object.entries(object).filter(([field]) =>
      ["subagent_type", "agent_type", "agent", "description"].includes(field)));
    if (Array.isArray(object.tasks)) metadata.tasks = object.tasks.map(task =>
      Object.fromEntries(Object.entries(inputObject(task)).filter(([field]) => ["agent", "description"].includes(field))));
    return { input: JSON.stringify(metadata) };
  }
  if (/^mcp[_.]/i.test(name)) {
    // Decode JSON escapes before scrubbing so encoded secrets cannot bypass redaction.
    let value = input ?? {};
    if (typeof input === "string") {
      try { value = JSON.parse(input); } catch { return { input, inputLimit: INPUT_LIMIT_BYTES }; }
    }
    return { input: JSON.stringify(value), inputLimit: INPUT_LIMIT_BYTES };
  }
  return {};
}

export function transcriptToolInvocation(callId: string, name: string, input: unknown, message?: ParsedMessage): TranscriptToolCall {
  return { callId, name, ...transcriptToolInput(name, input), message, outcome: "unknown", harnessError: null, exitCode: null };
}

type ResultEvidence = { output: string; error?: boolean; details?: Record<string, unknown> };

function resultExitCode(client: string, evidence: ResultEvidence): number | null {
  if (typeof evidence.details?.exitCode === "number" && Number.isSafeInteger(evidence.details.exitCode)) return evidence.details.exitCode;
  const match = client === "claude" ? evidence.output.match(/^Exit code (-?\d+)\b/m)
    : evidence.output.match(/^(?:Process exited with code|Command exited with code|Exit code:?) (-?\d+)\b/m);
  return match ? Number(match[1]) : null;
}

function ompOutcome(evidence: ResultEvidence): ToolOutcome | undefined {
  const { output, error, details } = evidence;
  if (details?.__interrupted === true || details?.source === "assistant_stop_aborted") return "interrupted";
  if (details?.__synthetic === true) return "unknown";
  if (details?.timedOut === true) return "failed";
  if (error === false || resultExitCode("omp", evidence) !== null) return undefined;
  if (/^(?:Operation aborted|Command aborted|Tool execution was aborted|Tool was not executed because the run was aborted)\b|(?:^|\n)\[Command (?:aborted|cancelled)\]/m.test(output)) return "interrupted";
  if (error !== true) return undefined;
  if (/^Tool call denied by user:/.test(output)) return "denied";
  if (/^(?:Blocked:|Tool "[^"]+" is blocked by (?:tool|user) policy\.|Tool execution was blocked)/.test(output)) return "blocked";
  return undefined;
}

/** Classify only harness evidence; no result or missing status never implies success. */
export function transcriptToolResult(callId: string, client: "claude" | "codex" | "omp", evidence: ResultEvidence): TranscriptToolCall {
  const { output, error } = evidence;
  const exitCode = resultExitCode(client, evidence);
  let outcome: ToolOutcome = "unknown";
  const omp = client === "omp" ? ompOutcome(evidence) : undefined;
  if (omp !== undefined) outcome = omp;
  else if (exitCode !== null) outcome = exitCode === 0 ? "succeeded" : "failed";
  else if (client === "claude") {
    if (/^\[Request interrupted by user/.test(output)) outcome = "interrupted";
    else if (error === true) outcome = output.startsWith("The user doesn't want to proceed") ? "denied" : "blocked";
    else if (error === false) outcome = "succeeded";
  } else if (client === "codex") {
    if (/(?:^|\n)\s*aborted by user\b/.test(output)) outcome = "interrupted";
    else if (/^(?:[\w.]+ failed: )?(?:User rejected|.*rejected by user)/i.test(output)) outcome = "denied";
    else if (/^(?:[\w.]+ failed: )?(?:command rejected by policy|Network access to "[^"]+" is blocked by policy)/i.test(output)) outcome = "blocked";
    else if (output.startsWith("Success. Updated the following files:")) outcome = "succeeded";
    else if (error === false) outcome = "succeeded";
  } else if (error === false) outcome = "succeeded";
  return { callId, outcome, harnessError: typeof error === "boolean" ? error : null, exitCode };
}
