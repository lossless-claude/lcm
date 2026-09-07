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


export async function handlePostToolUse(
  stdin: string,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  try {
    const input = JSON.parse(stdin);
    const { session_id, tool_name, tool_input, tool_response, tool_output, hook_event_name, error, is_interrupt } = input;

    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    const sourceHook = hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
    const events = extractPostToolEvents({
      tool_name, tool_input: tool_input ?? {}, tool_response, tool_output, hook_event_name: sourceHook, error, is_interrupt,
    });
    if (events.length === 0) return { exitCode: 0, stdout: "" };

    cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const dbPath = eventsDbPath(cwd as string);
    const db = new EventsDb(dbPath);

    try {
      for (const event of events) {
        db.insertEvent(session_id, event, sourceHook);
      }

      // Tier 1: fire-and-forget daemon promotion for high-priority events.
      // The /promote-events route uses getUnprocessed() which reads processed_at IS NULL,
      // so events already promoted by this call won't be re-promoted by the batch route
      // at session-end. No additional de-duplication guard needed.
      const hasPriority1 = events.some(e => e.priority === 1);
      if (hasPriority1) {
        firePromoteEventsRequest(await configuredDaemonPort(), { cwd });
      }
    } finally {
      db.close();
    }
  } catch (error) {
    safeLogError("PostToolUse", error, { cwd });
  }

  return { exitCode: 0, stdout: "" };
}
