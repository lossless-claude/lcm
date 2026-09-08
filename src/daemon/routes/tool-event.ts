import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { recordPostToolEvents } from "../../hooks/post-tool.js";
import { createPromoteEventsHandler } from "./promote-events.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { DaemonConfig } from "../config.js";

/**
 * POST /tool-event — the function-hooks module's replacement for the PostToolUse and
 * PostToolUseFailure command hooks. The module runs without Node or SQLite, so it hands
 * the tool call to the daemon and this route writes the events the command hook would
 * have written itself. Body: the PostToolUse payload plus `cwd`.
 */
export function createToolEventHandler(config: DaemonConfig): RouteHandler {
  const promoteEvents = createPromoteEventsHandler(config);

  return async (_req, res, body) => {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    // session_id becomes a TEXT key in SQLite; a non-string would write rows that never
    // match the ones the command hook path writes.
    if (typeof input.session_id !== "string" || !input.session_id
      || typeof input.tool_name !== "string" || !input.tool_name
      || typeof input.cwd !== "string" || !input.cwd) {
      sendJson(res, 400, { error: "session_id, tool_name and cwd required" });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const outcome = recordPostToolEvents({
      ...input, cwd, session_id: input.session_id, tool_name: input.tool_name,
    });
    sendJson(res, 200, { recorded: outcome.recorded, promoted: outcome.hasPriority1 });

    // Same tier-1 rule as the command hook: a priority-1 event is promoted now, not at
    // session end. In-process, after the response, so the hook's dispatch is not held.
    if (outcome.hasPriority1) {
      const sink = { writeHead: () => {}, end: () => {} } as unknown as Parameters<RouteHandler>[1];
      promoteEvents({} as Parameters<RouteHandler>[0], sink, JSON.stringify({ cwd }))
        .catch(err => safeLogError("tool-event", err, { cwd }));
    }
  };
}
