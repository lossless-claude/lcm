import type { LcmPaths } from "../../lcm-paths.js";
import { projectId } from "../project.js";
import { enqueue, withProjectMutation } from "../project-queue.js";
import { sendJson, type RouteHandler } from "../server.js";
import { clearTerminalTranscriptGuards } from "../subagent-guard-failures.js";
import { validateCwd } from "../validate-cwd.js";

export function createCaptureRetryHandler(paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    let input;
    try { input = JSON.parse(body || "{}"); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    if (!input || typeof input.cwd !== "string" ||
        !((typeof input.session_id === "string" && input.session_id.trim() !== "" && input.all === undefined) ||
          (input.all === true && input.session_id === undefined))) {
      sendJson(res, 400, { error: "cwd and exactly one of session_id or all: true are required" });
      return;
    }
    let cwd: string;
    try { cwd = validateCwd(input.cwd); } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }
    const pid = projectId(cwd);
    const cleared = await enqueue(pid, () => withProjectMutation(pid, async () =>
      clearTerminalTranscriptGuards(cwd, paths, input.session_id)));
    sendJson(res, 200, { cleared });
  };
}
