import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { join } from "node:path";
import { safeLogError } from "./hook-errors.js";
import { buildMemoryContext } from "./memory-context.js";
import { LEARNING_INSTRUCTION } from "./learning-instruction.js";
import { functionHooksOwnSession } from "./session-claim.js";
import { lcmPath } from "../lcm-home.js";
import { withHookWrite } from "./write-admission.js";

type PromptSearchResponse = {
  hints: string[];
  ids?: string[];
};

/** Deadline for /prompt-search — the user is waiting on every prompt; fall back to the bare instruction. */
const PROMPT_SEARCH_TIMEOUT_MS = 5_000;

/**
 * Extract passive-learning events from one user prompt and write them to the project's
 * events DB. Shared by the command hook and the daemon's /prompt-search route
 * (`recordEvents: true`, the function-hooks module's path). Returns the rows written.
 */
export async function recordUserPromptEvents(prompt: string, sessionId: string, cwd: string): Promise<number> {
  const { extractUserPromptEvents } = await import("./extractors.js");
  const { EventsDb } = await import("./events-db.js");
  const { eventsDbPath } = await import("../db/events-path.js");
  const { createHash } = await import("node:crypto");

  const events = extractUserPromptEvents(prompt);
  if (events.length === 0) return 0;
  // The dedup key both paths can compute: the module's prompt.submit sees the text and
  // no prompt id, so the id the command hook's stdin carries is no use here.
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  return withHookWrite(() => {
    const db = new EventsDb(eventsDbPath(cwd));
    try {
      return db.insertPromptEvents(sessionId, events, promptHash);
    } finally {
      db.close();
    }
  }, 0);
}

export async function handleUserPromptSubmit(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdin || "{}") as Record<string, unknown>;
  } catch {
    return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
  }

  // The module owns this event while it holds the session: prompt.section carries the
  // instruction and prompt.submit carries the memory context, so anything printed here
  // would reach the model twice.
  if (functionHooksOwnSession(parsed.session_id as string | undefined)) {
    return { exitCode: 0, stdout: "" };
  }

  const daemonPort = port ?? 3737;
  const pidFilePath = lcmPath("daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000, expectedVersion: PKG_VERSION });
  if (!connected) return { exitCode: 0, stdout: LEARNING_INSTRUCTION };

  try {
    const input = parsed as { prompt?: string; session_id?: string; cwd?: string };
    if (!input.prompt || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }

    // Sidecar event extraction — must happen before prompt-search, must never throw
    try {
      if (input.session_id && typeof input.session_id === "string") {
        const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
        await recordUserPromptEvents(String(input.prompt), input.session_id, cwd);
      }
    } catch (e) {
      safeLogError("UserPromptSubmit", e, {
        cwd: input.cwd ?? process.env.CLAUDE_PROJECT_DIR,
        sessionId: input.session_id,
      });
    }

    const result = await client.post<PromptSearchResponse>("/prompt-search", {
      query: input.prompt,
      cwd: input.cwd,
      session_id: input.session_id,
      learningInstructionBytes: Buffer.byteLength(LEARNING_INSTRUCTION, "utf8"),
    }, { timeoutMs: PROMPT_SEARCH_TIMEOUT_MS });

    if (!result.hints || result.hints.length === 0) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }

    const hint = buildMemoryContext(result.hints, result.ids ?? []);
    if (!hint) {
      return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
    }
    return { exitCode: 0, stdout: `${hint}\n${LEARNING_INSTRUCTION}` };
  } catch {
    return { exitCode: 0, stdout: LEARNING_INSTRUCTION };
  }
}
