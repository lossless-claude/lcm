// src/hooks/post-tool.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { firePromoteEventsRequest } from "./session-end.js";
import { safeLogError } from "./hook-errors.js";

/** Daemon port from ~/.lossless-claude/config.json — Claude Code does not pass it on stdin. */
async function configuredDaemonPort(): Promise<number> {
  try {
    const { loadDaemonConfig } = await import("../daemon/config.js");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    return loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json")).daemon?.port ?? 3737;
  } catch {
    return 3737;
  }
}

/** The PostToolUse / PostToolUseFailure payload, as the command hook and the daemon route both receive it. */
export interface PostToolPayload {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: { isError?: boolean };
  /** Claude Code's id for this tool call; both hook paths receive it. */
  tool_use_id?: string;
  hook_event_name?: string;
  error?: string;
  is_interrupt?: boolean;
}

export interface RecordedPostTool {
  /** Events written to the sidecar events DB. */
  recorded: number;
  /** True when at least one written event had priority 1 (promote now, not at session end). */
  hasPriority1: boolean;
  sourceHook: "PostToolUse" | "PostToolUseFailure";
}

/**
 * Extract passive-learning events from one tool call and write them to the project's
 * events DB. Shared by the command hook (stdin) and the daemon's POST /tool-event route
 * (function hooks module), so both paths record identical rows.
 */
export function recordPostToolEvents(payload: PostToolPayload): RecordedPostTool {
  const sourceHook = payload.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
  const events = extractPostToolEvents({
    tool_name: payload.tool_name,
    tool_input: payload.tool_input ?? {},
    tool_response: payload.tool_response,
    tool_output: payload.tool_output,
    hook_event_name: sourceHook,
    error: payload.error,
    is_interrupt: payload.is_interrupt,
  });
  if (events.length === 0) return { recorded: 0, hasPriority1: false, sourceHook };

  const db = new EventsDb(eventsDbPath(payload.cwd));
  try {
    // Skip the whole call, not each event: one call extracts several events, and a
    // per-event check would leave a half batch when the paths raced.
    if (payload.tool_use_id && db.hasToolCall(payload.session_id, payload.tool_use_id)) {
      return { recorded: 0, hasPriority1: false, sourceHook };
    }
    for (const event of events) {
      db.insertEvent(payload.session_id, event, sourceHook, payload.tool_use_id);
    }
  } finally {
    db.close();
  }
  return { recorded: events.length, hasPriority1: events.some(e => e.priority === 1), sourceHook };
}

/**
 * When the function-hooks module is loaded it records every tool call through the daemon's
 * POST /tool-event route; the command hook must then stay silent or every event lands twice.
 * The env var is the switch that loads the module, so it is also the dedup signal.
 */
export function functionHooksActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1";
}

export async function handlePostToolUse(
  stdin: string,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  let sourceHook = "PostToolUse";
  try {
    if (functionHooksActive()) return { exitCode: 0, stdout: "" };

    const input = JSON.parse(stdin);
    const { session_id, tool_name } = input;
    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const outcome = recordPostToolEvents({ ...input, cwd: cwd as string });
    sourceHook = outcome.sourceHook;

    // Tier 1: fire-and-forget daemon promotion for high-priority events.
    // The /promote-events route uses getUnprocessed() which reads processed_at IS NULL,
    // so events already promoted by this call won't be re-promoted by the batch route
    // at session-end. No additional de-duplication guard needed.
    if (outcome.hasPriority1) {
      firePromoteEventsRequest(await configuredDaemonPort(), { cwd });
    }
  } catch (error) {
    safeLogError(sourceHook, error, { cwd });
  }

  return { exitCode: 0, stdout: "" };
}
