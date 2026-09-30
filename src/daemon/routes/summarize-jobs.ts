import { sendJson, type RouteHandler } from "../server.js";
import { SummarizeJobStore, type JobAnswer } from "../summarize-jobs.js";

export function createNextSummarizeJobHandler(store: SummarizeJobStore): RouteHandler {
  return async (req, res) => {
    const query = new URL(req.url!, "http://localhost").searchParams;
    const sessionId = query.get("session_id");
    const workerId = query.get("worker_id");
    if (workerId !== null && (!workerId.trim() || sessionId !== null)) {
      sendJson(res, 400, { error: "provide worker_id or session_id" }); return;
    }
    if (!workerId && !sessionId?.trim()) { sendJson(res, 400, { error: "session_id is required" }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const wait = query.get("wait_ms") !== "0";
      const job = workerId ? await store.nextWorker(workerId, controller.signal, wait)
        : await store.next(sessionId!, controller.signal, wait);
      if (res.destroyed) return;
      if (job) sendJson(res, 200, { job });
      else { res.writeHead(204); res.end(); }
    } finally { res.off("close", abort); }
  };
}

export function createAnswerSummarizeJobHandler(store: SummarizeJobStore): RouteHandler {
  return async (req, res, body) => {
    let answer: JobAnswer;
    try { answer = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    if (!answer || typeof answer !== "object" ||
        !(Boolean(typeof answer.text === "string" && answer.text.trim()) !==
          Boolean(typeof answer.error === "string" && answer.error.trim()))) {
      sendJson(res, 400, { error: "provide non-empty text or error" }); return;
    }
    const validUsage = (usage: JobAnswer["usage"]): boolean => Boolean(usage &&
      Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 &&
      Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 &&
      typeof usage.estimated === "boolean");
    const validAttempts = answer.usageAttempts === undefined ||
      (Array.isArray(answer.usageAttempts) && answer.usageAttempts.length <= 2 &&
        answer.usageAttempts.every((attempt) => attempt &&
          ["session:haiku", "session:fork", "session-pool:haiku", "session-pool:sonnet"].includes(attempt.providerId) && validUsage(attempt.usage) &&
          (attempt.failed === undefined || typeof attempt.failed === "boolean")));
    // Require exactly one outcome and validate accounting before it reaches SQLite.
    if ((answer.text !== undefined && answer.error !== undefined) ||
        (answer.providerId !== undefined && !["session:haiku", "session:fork", "session-pool:haiku", "session-pool:sonnet"].includes(answer.providerId)) ||
        (answer.usage !== undefined && !validUsage(answer.usage)) || !validAttempts) {
      sendJson(res, 400, { error: "invalid answer or usage" }); return;
    }
    const id = req.url!.split("?")[0]!.slice("/summarize-jobs/".length);
    const result = store.answer(id, { ...answer, text: answer.text?.trim() });
    sendJson(res, result === "missing" ? 404 : 200,
      result === "missing" ? { error: "job not found" } : { discarded: result === "discarded" });
  };
}
