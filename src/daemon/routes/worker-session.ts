import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import type { SummarizeJobStore } from "../summarize-jobs.js";
import { workerBinding } from "../worker-admission.js";
import { workerEnrollments, finishWorkerSession, registerWorkerSession } from "../../worker-session.js";

/** Hook-only enrollment. Tool transports never register or convert sessions. */
export function createWorkerSessionHandler(paths: LcmPaths, jobs?: SummarizeJobStore): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    if (input.declared !== true || !["claude", "codex", "omp"].includes(input.client) ||
        typeof input.session_id !== "string" || !input.session_id.trim()) {
      sendJson(res, 403, { error: "Start a dedicated session with LCM_SUMMARIZE_WORKER=1; Agent transports cannot enroll sessions." }); return;
    }
    const cwd = validateCwd(input.cwd);
    if (input.action === "check") {
      const enrolled = workerEnrollments(cwd, paths).some(worker => worker.session_id === input.session_id &&
        worker.client === input.client && worker.state !== "finished" && worker.owner);
      const { WORKER_WARNING } = await import("../../worker-warning.js");
      sendJson(res, 200, enrolled ? { enrolled: true, warning: WORKER_WARNING } : {
        enrolled: false, reason: "No live command-hook enrollment was found; use a fresh dedicated session with a verifiable native harness owner.",
      });
      return;
    }
    if (typeof input.owner !== "string" || !input.owner.trim()) {
      sendJson(res, 403, { error: "Worker enrollment requires a verified native harness owner." }); return;
    }
    if (input.action === "finish") {
      const enrolled = workerEnrollments(cwd, paths).find(worker => worker.session_id === input.session_id && worker.owner === input.owner);
      if (!enrolled) { sendJson(res, 403, { error: "worker owner does not match" }); return; }
      await finishWorkerSession(paths, cwd, input.session_id);
      jobs?.revokeIdentity(workerBinding(cwd, input.client, input.session_id));
      sendJson(res, 200, { finished: true }); return;
    }
    if (input.source !== "startup" && input.source !== "clear") {
      if (input.source !== "compact") {
        await finishWorkerSession(paths, cwd, input.session_id);
        jobs?.revokeIdentity(workerBinding(cwd, input.client, input.session_id));
      }
      sendJson(res, 403, { error: "Worker enrollment requires a new session id from startup or clear; resume, compact, continue and fork are unsupported." }); return;
    }
    const revokeFinished = () => {
      for (const worker of workerEnrollments(cwd, paths)) if (worker.state === "finished") {
        jobs?.revokeIdentity(workerBinding(cwd, worker.client, worker.session_id));
      }
    };
    let result;
    try { result = await registerWorkerSession(paths, { sessionId: input.session_id, cwd, client: input.client, owner: input.owner, source: input.source }); }
    catch (error) { revokeFinished(); sendJson(res, 403, { error: (error as Error).message }); return; }
    revokeFinished();
    sendJson(res, 200, result);
  };
}
