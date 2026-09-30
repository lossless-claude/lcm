import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "../daemon/client.js";
import { resolveLcmConfig } from "../db/config.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { daemonNotice, warnOncePerSession } from "./fail-open.js";
import { buildMemoryContext } from "./memory-context.js";
import { LEARNING_INSTRUCTION_CLI } from "../guidance.js";
import { lcmHome } from "../lcm-home.js";
import { createLcmPaths, type LcmPaths } from "../lcm-paths.js";
import { firePromoteEventsRequest } from "./daemon-requests.js";
import { translateToolCall, type ToolVocabulary } from "./tool-vocabulary.js";
import { observeHook } from "./observe.js";

const EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd", "PreCompact",
]);
const TOOL_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const CONTEXT_BYTES = 16_000;
const RESTORE_EVIDENCE_BYTES = 256 * 1024;
const EMPTY = { exitCode: 0, stdout: "" };

type CodexInput = {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  transcript_path?: string;
  source?: string;
  prompt?: string;
};

/**
 * A Codex `PostToolUse` / `PostToolUseFailure` payload. Codex's hook reference
 * names these fields the same way Claude Code's tool hooks do — `tool_name`,
 * `tool_input`, `tool_response`, `tool_use_id`, `error` — with one addition:
 * `model`, the id of the model that issued the call. Claude's payload has no
 * such field, which is why that harness's rows are backfilled from the
 * transcript at ingest instead.
 */
type CodexToolInput = {
  hook_event_name: "PostToolUse" | "PostToolUseFailure";
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  turn_id?: string;
  error?: string;
  is_interrupt?: boolean;
  model?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput(stdin: string): CodexToolInput | null {
  const input = JSON.parse(stdin || "{}");
  if (!input || typeof input !== "object" ||
      !TOOL_EVENTS.has(input.hook_event_name) ||
      typeof input.session_id !== "string" || !input.session_id.trim() ||
      typeof input.cwd !== "string" || !input.cwd.trim() ||
      typeof input.tool_name !== "string" || !input.tool_name.trim()) return null;
  return {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    tool_name: input.tool_name,
    ...(isRecord(input.tool_input) ? { tool_input: input.tool_input } : {}),
    ...(input.tool_response !== undefined ? { tool_response: input.tool_response } : {}),
    ...(typeof input.tool_use_id === "string" && input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
    ...(typeof input.turn_id === "string" && input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(typeof input.error === "string" ? { error: input.error } : {}),
    ...(typeof input.is_interrupt === "boolean" ? { is_interrupt: input.is_interrupt } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
  };
}

function codexPatchPaths(command: unknown): string[] {
  if (typeof command !== "string") return [];
  return [...new Set(
    [...command.matchAll(/^\*\*\* (?:(?:Update|Add|Delete) File: (.+)|Move to: (.+))$/gm)]
      .map(match => (match[1] ?? match[2]).trim())
      .filter(Boolean),
  )];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Codex's tool ids as its hook reports them, onto the extractor's vocabulary.
 *
 * Codex names two paths by their local function name rather than by what they do, and
 * reports a plan tool and a subagent tool the extractor has no id for. Everything else
 * either matches already (`mcp__*` by prefix) or is deliberately silent below.
 */
const CODEX_TOOL_VOCABULARY: ToolVocabulary = {
  // Compatibility for hosts that serialize unified command execution by its local
  // function name; Codex's hook reference matches this path as Bash.
  exec_command: { canonical: "Bash" },
  apply_patch: {
    canonical: "Edit",
    input: (call) => {
      const filePaths = codexPatchPaths(call.input.command);
      // A patch that names no file carries nothing the file extractor can use.
      return filePaths.length === 0 ? undefined : { ...call.input, file_paths: filePaths };
    },
  },
  update_plan: {
    canonical: "TaskUpdate",
    // Real shape, from this machine's Codex rollouts:
    // { explanation?: string, plan: [{ step: string, status: "pending"|"in_progress"|"completed" }] }
    // The current step is the memory worth keeping; a status is passed through in
    // Codex's own words rather than translated, since the extractor treats it as prose.
    input: (call) => {
      const plan = Array.isArray(call.input.plan) ? call.input.plan.filter(isRecord) : [];
      if (plan.length === 0) return undefined;
      const current = plan.find((step) => step.status === "in_progress") ?? plan[plan.length - 1];
      const subject = firstNonEmptyString(current.step);
      if (!subject) return undefined;
      return { ...call.input, subject, status: firstNonEmptyString(current.status) ?? "updated" };
    },
  },
  spawn_agent: {
    canonical: "Agent",
    // The extractor keys subagent dispatches on `description`. No `spawn_agent` call
    // exists in the local rollouts, so its payload field is unverified: read the
    // plausible ones and decline rather than invent a description.
    input: (call) => {
      const description = firstNonEmptyString(call.input.description, call.input.prompt, call.input.label);
      return description === undefined ? undefined : { ...call.input, description };
    },
  },
  // Transport for an existing unified-exec session: the command's own PostToolUse
  // arrives when it finishes, so this is not an act of its own.
  write_stdin: { silent: "transport for an existing exec session, not an act" },
};

/**
 * Codex `PostToolUse` / `PostToolUseFailure`. This writes straight to the
 * project's local sidecar, exactly like Claude Code's command hook does —
 * no daemon round trip, since PostToolUse can fire 50-200x/session and the
 * events table lives beside the project, not behind the daemon.
 */
async function dispatchCodexToolHook(stdin: string, paths: LcmPaths): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = parseToolInput(stdin);
    if (!input) return EMPTY;
    const translated = translateToolCall(CODEX_TOOL_VOCABULARY, {
      toolName: input.tool_name,
      input: input.tool_input ?? {},
      response: input.tool_response,
    });
    // Imported here, not at module scope: tool-events.js pulls node:sqlite, whose
    // ExperimentalWarning would then reach stderr on every lifecycle no-op too.
    const { recordPostToolEvents } = await import("./tool-events.js");
    // The translated name and input lead; every other field (the failure flag, the
    // error text, the turn id) still belongs to the payload as the harness sent it.
    const outcome = recordPostToolEvents({ ...input, ...translated, client: "codex" }, paths);
    if (outcome.hasPriority1) {
      const config = loadDaemonConfig(paths.configPath);
      firePromoteEventsRequest(config.daemon?.port ?? 3737, { cwd: input.cwd }, paths);
    }
  } catch (error) {
    console.error(`[lcm] Codex tool hook failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return EMPTY;
}

export interface CodexHookDeps {
  client: Pick<DaemonClient, "post">;
  /** `noSpawn`: only check a running daemon (short-deadline events), never start one. */
  connect: (sessionId?: string, noSpawn?: boolean) => Promise<boolean>;
  /** `LCM_ENABLED=false` in the defaults; the hook exits at once when false. */
  enabled: boolean;
  /** The storage root both branches write under, so an injected dependency isolates both. */
  paths: LcmPaths;
}

function parseInput(stdin: string): CodexInput | null {
  const input = JSON.parse(stdin || "{}");
  if (!input || typeof input !== "object" ||
      !EVENTS.has(input.hook_event_name) ||
      typeof input.session_id !== "string" || !input.session_id.trim() ||
      typeof input.cwd !== "string" || !input.cwd.trim()) return null;
  return {
    hook_event_name: input.hook_event_name,
    session_id: input.session_id,
    cwd: input.cwd,
    ...(typeof input.transcript_path === "string" ? { transcript_path: input.transcript_path } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
  };
}

function defaultDeps(): CodexHookDeps {
  const paths: LcmPaths = createLcmPaths(lcmHome());
  const config = loadDaemonConfig(paths.configPath);
  const port = config.daemon?.port ?? 3737;
  return {
    paths,
    enabled: resolveLcmConfig().enabled,
    client: new DaemonClient(`http://127.0.0.1:${port}`, paths.tokenPath),
    // Codex must not run the Claude bootstrap that rewrites Claude settings, so the
    // fail-open notice is written here, once per session, instead of by ensureBootstrapped.
    connect: async (sessionId, noSpawn = false) => {
      const result = await ensureDaemon({
        port, pidFilePath: paths.pidPath, spawnTimeoutMs: noSpawn ? 0 : 5000, noSpawn, expectedVersion: PKG_VERSION,
      });
      const notice = daemonNotice(result, PKG_VERSION);
      // A short-deadline event never tried to start a daemon, so an absent one is no news.
      const startWasNotAttempted = noSpawn && !result.ownership;
      if (notice && sessionId && !startWasNotAttempted) warnOncePerSession(sessionId, "daemon", notice.line, paths);
      return result.connected && notice?.usable !== false;
    },
  };
}

function boundContext(context: string, limit = CONTEXT_BYTES): string {
  // A byte cap also bounds non-ASCII output without splitting surrogate pairs.
  let bytes = 0;
  const bounded: string[] = [];
  for (const point of context) {
    bytes += Buffer.byteLength(point, "utf8");
    if (bytes > limit) break;
    bounded.push(point);
  }
  return bounded.join("");
}

function contextOutput(event: string, context: string): typeof EMPTY {
  if (!context.trim()) return EMPTY;
  return {
    exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput: {
      hookEventName: event, additionalContext: boundContext(context),
    } }),
  };
}

// Every UserPromptSubmit carries the learning instruction, whether or not memory was
// surfaced, so a Codex agent is told how to store on every turn. The cap trims the memory
// context, never the instruction; the daemon reserves the same bytes out of the hint budget.
const INSTRUCTION_SUFFIX = `\n${LEARNING_INSTRUCTION_CLI}`;
const INSTRUCTION_BYTES = Buffer.byteLength(INSTRUCTION_SUFFIX, "utf8");

function promptOutput(memoryContext: string): typeof EMPTY {
  const bounded = boundContext(memoryContext, CONTEXT_BYTES - INSTRUCTION_BYTES);
  return contextOutput("UserPromptSubmit", bounded.trim() ? `${bounded}${INSTRUCTION_SUFFIX}` : LEARNING_INSTRUCTION_CLI);
}

async function readRestoreEvidence(transcriptPath: string): Promise<string | null> {
  const file = await open(transcriptPath, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, RESTORE_EVIDENCE_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    if (bytesRead !== length) return null;
    const tail = buffer.toString("utf8");
    // A bounded tail may begin inside a record or a UTF-8 character.
    const start = size > length ? tail.indexOf("\n") + 1 : 0;
    if (size > length && start === 0) return null;
    return tail.slice(start);
  } finally {
    await file.close();
  }
}

/** A resume hook can already have restored this exact context after compaction. */
async function hasContextAfterCompaction(transcriptPath: string, context: string): Promise<boolean> {
  if (!context.trim()) return false;
  const expected = boundContext(context);
  let compacted = false;
  let found = false;
  try {
    const transcript = await readRestoreEvidence(transcriptPath);
    // An unfinished record could be a newer compaction boundary. Never use a
    // partial snapshot as evidence that the old developer context survived.
    if (!transcript?.endsWith("\n")) return false;
    for (const line of transcript.split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return false; }
      if (record?.type === "compacted") {
        compacted = true;
        found = false;
      } else if (compacted && record?.type === "response_item" &&
                 record.payload?.type === "message" && record.payload.role === "developer") {
        const content = record.payload.content;
        if (Array.isArray(content) && content.some(block => typeof block?.text === "string" && block.text.includes(expected))) {
          found = true;
        }
      }
    }
  } catch {
    // Without positive transcript evidence, restore rather than risk missing memory.
    return false;
  }
  return found;
}

/** Native Codex command hook. Failures never block a turn or native compaction. */
export async function dispatchCodexHook(
  stdin: string,
  dependencies?: CodexHookDeps,
): Promise<{ exitCode: number; stdout: string }> {
  const { client, connect, enabled, paths } = dependencies ?? defaultDeps();
  if (!enabled) return EMPTY;
  try {
    const peeked: unknown = JSON.parse(stdin || "{}");
    if (isRecord(peeked) && typeof peeked.hook_event_name === "string" && TOOL_EVENTS.has(peeked.hook_event_name)) {
      return dispatchCodexToolHook(stdin, paths);
    }
  } catch {
    // Malformed stdin falls through to the lifecycle parser, which rejects it too.
  }
  let observedInput: CodexInput | undefined;
  let activeOperation = "capture";
  try {
    const input = parseInput(stdin);
    if (!input) return EMPTY;
    if (process.env.LCM_SUMMARIZE_WORKER === "1") {
      if (input.hook_event_name === "SessionStart" && input.source !== "subagent") {
        const { registerWorkerSession } = await import("../worker-session.js");
        const result = await registerWorkerSession(paths, { sessionId: input.session_id, cwd: input.cwd,
          client: "codex", owner: `codex-hook:${process.ppid}` });
        console.error(`[lcm] ${result.warning} Promotions without provenance: ${result.unprovenanced}.`);
      }
      if (input.hook_event_name === "SessionEnd") {
        const { finishWorkerSession } = await import("../worker-session.js");
        await finishWorkerSession(paths, input.cwd, input.session_id);
      }
      return EMPTY;
    }
    observedInput = input;
    const shortDeadline = input.hook_event_name === "Interrupt" || input.hook_event_name === "SessionEnd";
    const compacting = input.hook_event_name === "PreCompact";
    if (compacting) activeOperation = "precompact";
    const observe = (operation: string, status: "completed" | "deferred" | "failed", reason = "") =>
      observeHook(input.cwd, { sessionId: input.session_id, harness: "codex",
        hook: input.hook_event_name, operation, kind: "execution", status, reason,
        ...(status === "failed" ? { failureCode: reason } : {}) }, paths);
    const observeDelivery = (operation: string, status: "accepted" | "rejected" | "unconfirmed", reason = "") =>
      observeHook(input.cwd, { sessionId: input.session_id, harness: "codex",
        hook: input.hook_event_name, operation, kind: "delivery", status, reason,
        ...(status === "rejected" ? { failureCode: reason } : {}) }, paths);
    const precompactOperationId = compacting ? randomUUID() : undefined;
    const observePrecompactDelivery = (status: "accepted" | "rejected" | "unconfirmed", reason?: string) => {
      if (!precompactOperationId) return;
      observeHook(input.cwd, {
        sessionId: input.session_id, harness: "codex", hook: "PreCompact", operation: "precompact",
        kind: "delivery", status, reason, operationId: precompactOperationId,
        ...(status === "rejected" ? { failureCode: reason ?? "rejected" } : {}),
      }, paths);
    };
    // Codex caps Interrupt and SessionEnd hooks at three seconds. Never start a
    // daemon there; one health probe still keeps an incompatible daemon unused.
    let connected = false;
    try {
      connected = await connect(input.session_id, shortDeadline);
    } catch { /* Connection failure is reported by the common no-connection branch. */ }
    if (!connected) {
      console.error("[lcm] Codex memory daemon is unavailable; capture and recall deferred.");
      if (compacting) observePrecompactDelivery("unconfirmed", "daemon-unavailable");
      else {
        observeDelivery("capture", "unconfirmed", "daemon-unavailable");
        if (input.hook_event_name === "SessionStart") observeDelivery("restore", "unconfirmed", "daemon-unavailable");
        if (input.hook_event_name === "UserPromptSubmit" && input.prompt?.trim())
          observeDelivery("search", "unconfirmed", "daemon-unavailable");
      }
      return input.hook_event_name === "UserPromptSubmit" ? promptOutput("") : EMPTY;
    }
    const signal = AbortSignal.timeout(shortDeadline ? 2000 : compacting ? 120_000 : 15_000);
    const identity = { session_id: input.session_id, cwd: input.cwd, client: "codex" };
    let transcriptValidated = false;

    // Capture on every turn and before restore/compaction. The daemon serializes
    // ingestion and owns deduplication, so retries and overlapping hooks are safe.
    if (input.transcript_path && !compacting) {
      try {
        await client.post("/ingest", {
          ...identity, transcript_path: input.transcript_path,
        }, { timeoutMs: shortDeadline ? 1500 : 5000, signal });
        transcriptValidated = true;
        observeDelivery("capture", "accepted");
        observe("capture", "completed");
      } catch (error) {
        // Existing memory remains useful even if a transcript is not ready yet.
        console.error(`[lcm] Codex ${input.hook_event_name} capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
        const status = (error as { status?: unknown })?.status;
        observeDelivery("capture", typeof status === "number" ? "rejected" : "unconfirmed",
          typeof status === "number" ? `http-${status}` : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
      }
    } else if (!compacting) observe("capture", "deferred", "source-unavailable");

    if (input.hook_event_name === "SessionStart") {
      activeOperation = "restore";
      const restored = await client.post<{ context?: string }>("/restore", {
        ...identity, source: input.source ?? "startup",
      }, { timeoutMs: 10_000, signal });
      observeDelivery("restore", "accepted");
      observe("restore", "completed", restored.context ? "context" : "no-context");
      if (input.source === "compact" && transcriptValidated && input.transcript_path &&
          await hasContextAfterCompaction(input.transcript_path, restored.context ?? "")) return EMPTY;
      return contextOutput("SessionStart", restored.context ?? "");
    }
    if (input.hook_event_name === "UserPromptSubmit" && input.prompt?.trim()) {
      activeOperation = "search";
      const recalled = await client.post<{
        hints?: string[]; ids?: string[]; projectIds?: (string | null)[]; pivotHint?: string;
      }>("/prompt-search", {
        ...identity, query: input.prompt, learningInstructionBytes: INSTRUCTION_BYTES, nativeHistory: true,
      }, { timeoutMs: 5000, signal });
      observeDelivery("search", "accepted");
      observe("search", "completed", recalled.hints?.length ? "hints" : "no-hints");
      return promptOutput(buildMemoryContext(
        recalled.hints ?? [], recalled.ids ?? [], recalled.projectIds ?? [], recalled.pivotHint,
      ) ?? "");
    }
    if (input.hook_event_name === "UserPromptSubmit") {
      observe("search", "deferred", "empty-prompt");
      return promptOutput("");
    }
    if (compacting) {
      activeOperation = "precompact";
      try {
        await client.post("/compact", {
          ...identity, transcript_path: input.transcript_path, capture_required: true,
          operation_id: precompactOperationId,
        }, { timeoutMs: 115_000, signal });
        observePrecompactDelivery("accepted");
      } catch (err) {
        const status = (err as { status?: unknown })?.status;
        observePrecompactDelivery(typeof status === "number" ? "rejected" : "unconfirmed",
          typeof status === "number" ? `http-${status}` : err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport");
        throw err;
      }
      // SessionStart(source=compact) restores the saved memory. PreCompact output
      // is advisory, and must not be used as the continuation delivery channel.
    }
    return EMPTY;
  } catch (error) {
    if (observedInput && activeOperation !== "precompact") {
      const status = (error as { status?: unknown })?.status;
      observeHook(observedInput.cwd, {
        sessionId: observedInput.session_id, harness: "codex", hook: observedInput.hook_event_name,
        operation: activeOperation, kind: "delivery",
        status: typeof status === "number" ? "rejected" : "unconfirmed",
        reason: typeof status === "number" ? `http-${status}` : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport",
      }, paths);
    }
    console.error(`[lcm] Codex hook failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return observedInput?.hook_event_name === "UserPromptSubmit" ? promptOutput("") : EMPTY;
  }
}
