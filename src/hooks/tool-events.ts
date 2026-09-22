// src/hooks/tool-events.ts
import { extractPostToolEvents } from "./extractors.js";
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import type { LcmPaths } from "../lcm-paths.js";
import type { SessionClient } from "../session-client.js";
import { isSessionClient } from "../session-client.js";
import { withHookWrite } from "./write-admission.js";

/**
 * The PostToolUse / PostToolUseFailure payload, as the command hook and the
 * daemon route both receive it. Client-agnostic: the Codex hook normalizes its
 * payload into this shape before recording.
 */
export interface PostToolPayload {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: { isError?: boolean };
  /** Claude Code's id for this tool call; both hook paths receive it. */
  tool_use_id?: string;
  /** Codex turn id, used only to backfill a missing Codex model from its transcript. */
  turn_id?: string;
  hook_event_name?: string;
  error?: string;
  is_interrupt?: boolean;
  /** Which harness produced this call. Defaults to "claude" — the Codex normalizer is the only other writer. */
  client?: SessionClient;
  /** The model that issued the tool call. Codex's hook payload carries it; Claude's does not, so it stays null until the next ingest backfills it. */
  model?: string | null;
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
 * events DB. Shared by both clients' hook adapters and the daemon's POST /tool-event
 * route (function hooks module), so all paths record identical rows.
 */
export function recordPostToolEvents(payload: PostToolPayload, paths: LcmPaths): RecordedPostTool {
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

  // The command hook forwards raw stdin, so the id is only trusted once it is a
  // non-empty string; both call sites get the same normalization this way.
  const toolUseId = typeof payload.tool_use_id === "string" && payload.tool_use_id
    ? payload.tool_use_id
    : undefined;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id.trim() || undefined : undefined;

  const client: SessionClient = isSessionClient(payload.client) ? payload.client : "claude";
  const model = typeof payload.model === "string" && payload.model ? payload.model : null;

  const recorded = withHookWrite(paths, () => {
    const db = new EventsDb(eventsDbPath(payload.cwd, paths));
    try {
      // Dedup on the whole call, not each event: one call extracts several events, and a
      // per-event check would leave a half batch when the paths raced.
      return db.insertToolCallEvents(payload.session_id, events, sourceHook, toolUseId, client, model, turnId);
    } finally {
      db.close();
    }
  }, 0);
  if (recorded === 0) return { recorded: 0, hasPriority1: false, sourceHook };
  return { recorded, hasPriority1: events.some(e => e.priority === 1), sourceHook };
}
