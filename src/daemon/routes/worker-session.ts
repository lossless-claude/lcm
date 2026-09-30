import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { registerWorkerSession } from "../../worker-session.js";

/** Hook-only enrollment. Tool transports never register or convert sessions. */
export function createWorkerSessionHandler(paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    if (input.declared !== true || !["claude", "codex"].includes(input.client) ||
        typeof input.session_id !== "string" || !input.session_id.trim() ||
        typeof input.owner !== "string" || !input.owner.trim()) {
      sendJson(res, 403, { error: "Start a dedicated session with LCM_SUMMARIZE_WORKER=1; OMP enrollment is unverified." }); return;
    }
    const cwd = validateCwd(input.cwd);
    const result = await registerWorkerSession(paths, { sessionId: input.session_id, cwd, client: input.client, owner: input.owner });
    sendJson(res, 200, result);
  };
}
