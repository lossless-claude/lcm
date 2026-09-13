import { join } from "node:path";
import { open } from "node:fs/promises";
import { DaemonClient } from "../daemon/client.js";
import { resolveLcmConfig } from "../db/config.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { daemonNotice, warnOncePerSession } from "./fail-open.js";
import { buildMemoryContext } from "./memory-context.js";
import { lcmHome } from "../lcm-home.js";
import { firePromoteEventsRequest } from "./session-end.js";

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
    ...(typeof input.error === "string" ? { error: input.error } : {}),
    ...(typeof input.is_interrupt === "boolean" ? { is_interrupt: input.is_interrupt } : {}),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
  };
}

/**
 * Codex `PostToolUse` / `PostToolUseFailure`. This writes straight to the
 * project's local sidecar, exactly like Claude Code's command hook does —
 * no daemon round trip, since PostToolUse can fire 50-200x/session and the
 * events table lives beside the project, not behind the daemon.
 */
async function dispatchCodexToolHook(stdin: string): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = parseToolInput(stdin);
    if (!input) return EMPTY;
    // Imported here, not at module scope: post-tool.js pulls node:sqlite, whose
    // ExperimentalWarning would then reach stderr on every lifecycle no-op too.
    const { recordPostToolEvents } = await import("./post-tool.js");
    const outcome = recordPostToolEvents({ ...input, client: "codex" });
    if (outcome.hasPriority1) {
      const config = loadDaemonConfig(join(lcmHome(), "config.json"));
      firePromoteEventsRequest(config.daemon?.port ?? 3737, { cwd: input.cwd });
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
  const base = lcmHome();
  const config = loadDaemonConfig(join(base, "config.json"));
  const port = config.daemon?.port ?? 3737;
  return {
    enabled: resolveLcmConfig().enabled,
    client: new DaemonClient(`http://127.0.0.1:${port}`),
    // Codex must not run the Claude bootstrap that rewrites Claude settings, so the
    // fail-open notice is written here, once per session, instead of by ensureBootstrapped.
    connect: async (sessionId, noSpawn = false) => {
      const result = await ensureDaemon({
        port, pidFilePath: join(base, "daemon.pid"), spawnTimeoutMs: noSpawn ? 0 : 5000, noSpawn, expectedVersion: PKG_VERSION,
      });
      const notice = daemonNotice(result, PKG_VERSION);
      // A short-deadline event never tried to start a daemon, so an absent one is no news.
      const startWasNotAttempted = noSpawn && !result.ownership;
      if (notice && sessionId && !startWasNotAttempted) warnOncePerSession(sessionId, "daemon", notice.line);
      return result.connected && notice?.usable !== false;
    },
  };
}

function boundContext(context: string): string {
  // A byte cap also bounds non-ASCII output without splitting surrogate pairs.
  let bytes = 0;
  const bounded: string[] = [];
  for (const point of context) {
    bytes += Buffer.byteLength(point, "utf8");
    if (bytes > CONTEXT_BYTES) break;
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
  const { client, connect, enabled } = dependencies ?? defaultDeps();
  if (!enabled) return EMPTY;
  try {
    const peeked: unknown = JSON.parse(stdin || "{}");
    if (isRecord(peeked) && typeof peeked.hook_event_name === "string" && TOOL_EVENTS.has(peeked.hook_event_name)) {
      return dispatchCodexToolHook(stdin);
    }
  } catch {
    // Malformed stdin falls through to the lifecycle parser, which rejects it too.
  }
  try {
    const input = parseInput(stdin);
    if (!input) return EMPTY;
    const shortDeadline = input.hook_event_name === "Interrupt" || input.hook_event_name === "SessionEnd";
    // Codex caps Interrupt and SessionEnd hooks at three seconds. Never start a
    // daemon there; one health probe still keeps an incompatible daemon unused.
    if (!await connect(input.session_id, shortDeadline)) {
      console.error("[lcm] Codex memory daemon is unavailable; capture and recall deferred.");
      return EMPTY;
    }
    const compacting = input.hook_event_name === "PreCompact";
    const signal = AbortSignal.timeout(shortDeadline ? 2000 : compacting ? 120_000 : 15_000);
    const identity = { session_id: input.session_id, cwd: input.cwd, client: "codex" };
    let transcriptValidated = false;

    // Capture on every turn and before restore/compaction. The daemon serializes
    // ingestion and owns deduplication, so retries and overlapping hooks are safe.
    if (input.transcript_path) {
      try {
        await client.post("/ingest", {
          ...identity, transcript_path: input.transcript_path,
        }, { timeoutMs: shortDeadline ? 1500 : 5000, signal });
        transcriptValidated = true;
      } catch (error) {
        // Existing memory remains useful even if a transcript is not ready yet.
        console.error(`[lcm] Codex ${input.hook_event_name} capture failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    if (input.hook_event_name === "SessionStart") {
      const restored = await client.post<{ context?: string }>("/restore", {
        ...identity, source: input.source ?? "startup",
      }, { timeoutMs: 10_000, signal });
      if (input.source === "compact" && transcriptValidated && input.transcript_path &&
          await hasContextAfterCompaction(input.transcript_path, restored.context ?? "")) return EMPTY;
      return contextOutput("SessionStart", restored.context ?? "");
    }
    if (input.hook_event_name === "UserPromptSubmit" && input.prompt?.trim()) {
      const recalled = await client.post<{
        hints?: string[]; ids?: string[]; projectIds?: (string | null)[]; pivotHint?: string;
      }>("/prompt-search", {
        ...identity, query: input.prompt, learningInstructionBytes: 0,
      }, { timeoutMs: 5000, signal });
      return contextOutput("UserPromptSubmit", buildMemoryContext(
        recalled.hints ?? [], recalled.ids ?? [], recalled.projectIds ?? [], recalled.pivotHint,
      ) ?? "");
    }
    if (compacting) {
      await client.post("/compact", {
        ...identity, skip_ingest: true,
      }, { timeoutMs: 115_000, signal });
      // SessionStart(source=compact) restores the saved memory. PreCompact output
      // is advisory, and must not be used as the continuation delivery channel.
    }
    return EMPTY;
  } catch (error) {
    console.error(`[lcm] Codex hook failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return EMPTY;
  }
}
