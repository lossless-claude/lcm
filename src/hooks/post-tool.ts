// src/hooks/post-tool.ts
import { firePromoteEventsRequest } from "./daemon-requests.js";
import { safeLogError } from "./hook-errors.js";
import { functionHooksOwnSession } from "./session-claim.js";
import type { LcmPaths } from "../lcm-paths.js";
import { recordPostToolEvents } from "./tool-events.js";

// Back-compat re-export: some callers historically imported the function-hooks gate from this module.
export { functionHooksActive, functionHooksOwnSession } from "./session-claim.js";

/** Daemon port from config.json — Claude Code does not pass it on stdin. */
async function configuredDaemonPort(paths: LcmPaths): Promise<number> {
  try {
    // Deliberately dynamic: this hook runs on every tool call, and the config module
    // is only needed when a priority-1 event actually fires a promote request.
    const { loadDaemonConfig } = await import("../daemon/config.js");
    return loadDaemonConfig(paths.configPath).daemon?.port ?? 3737;
  } catch {
    return 3737;
  }
}

export async function handlePostToolUse(
  stdin: string,
  paths: LcmPaths,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  let sourceHook = "PostToolUse";
  try {
    const input = JSON.parse(stdin);
    const { session_id, tool_name } = input;
    if (!tool_name || !session_id) return { exitCode: 0, stdout: "" };

    // The module records every tool call through POST /tool-event while it owns the
    // session; recording here too would write the same events a second time.
    if (functionHooksOwnSession(session_id)) return { exitCode: 0, stdout: "" };

    cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const outcome = recordPostToolEvents({ ...input, cwd: cwd as string }, paths);
    sourceHook = outcome.sourceHook;

    // Tier 1: fire-and-forget daemon promotion for high-priority events.
    // The /promote-events route uses getUnprocessed() which reads processed_at IS NULL,
    // so events already promoted by this call won't be re-promoted by the batch route
    // at session-end. No additional de-duplication guard needed.
    if (outcome.hasPriority1) {
      firePromoteEventsRequest(await configuredDaemonPort(paths), { cwd }, paths);
    }
  } catch (error) {
    safeLogError(sourceHook, error, { cwd, paths });
  }

  return { exitCode: 0, stdout: "" };
}
