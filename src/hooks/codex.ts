import { join } from "node:path";
import { open } from "node:fs/promises";
import { DaemonClient } from "../daemon/client.js";
import { resolveLcmConfig } from "../db/config.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { buildMemoryContext } from "./memory-context.js";
import { lcmHome } from "../lcm-home.js";

const EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd", "PreCompact",
]);
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

export interface CodexHookDeps {
  client: Pick<DaemonClient, "post">;
  connect: () => Promise<boolean>;
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
    // Codex must not run the Claude bootstrap that rewrites Claude settings.
    connect: async () => (await ensureDaemon({
      port, pidFilePath: join(base, "daemon.pid"), spawnTimeoutMs: 5000,
    })).connected,
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
    const input = parseInput(stdin);
    if (!input) return EMPTY;
    const shortDeadline = input.hook_event_name === "Interrupt" || input.hook_event_name === "SessionEnd";
    // Codex caps Interrupt and SessionEnd hooks at three seconds. Do not start
    // or probe the daemon; send one short write to an already running daemon.
    if (!shortDeadline && !await connect()) {
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
      const recalled = await client.post<{ hints?: string[]; ids?: string[] }>("/prompt-search", {
        ...identity, query: input.prompt, learningInstructionBytes: 0,
      }, { timeoutMs: 5000, signal });
      return contextOutput("UserPromptSubmit", buildMemoryContext(recalled.hints ?? [], recalled.ids ?? []) ?? "");
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
