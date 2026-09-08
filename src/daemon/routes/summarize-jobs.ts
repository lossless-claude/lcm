import { sendJson, type RouteHandler } from "../server.js";
import { SummarizeJobStore, type JobAnswer } from "../summarize-jobs.js";

export function createNextSummarizeJobHandler(store: SummarizeJobStore): RouteHandler {
  return async (req, res) => {
    const query = new URL(req.url!, "http://localhost").searchParams;
    const sessionId = query.get("session_id");
    if (!sessionId?.trim()) { sendJson(res, 400, { error: "session_id is required" }); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    try {
      const job = await store.next(sessionId, controller.signal, query.get("wait_ms") !== "0");
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
    // Require exactly one outcome and validate accounting before it reaches SQLite.
    if ((answer.text !== undefined && answer.error !== undefined) ||
        (answer.providerId !== undefined && !["session:haiku", "session:fork"].includes(answer.providerId)) ||
        (answer.usage !== undefined && (!answer.usage ||
          !Number.isSafeInteger(answer.usage.input_tokens) || answer.usage.input_tokens < 0 ||
          !Number.isSafeInteger(answer.usage.output_tokens) || answer.usage.output_tokens < 0 ||
          typeof answer.usage.estimated !== "boolean"))) {
      sendJson(res, 400, { error: "invalid answer or usage" }); return;
    }
    const id = req.url!.split("?")[0]!.slice("/summarize-jobs/".length);
    const result = store.answer(id, { ...answer, text: answer.text?.trim() });
    sendJson(res, result === "missing" ? 404 : 200,
      result === "missing" ? { error: "job not found" } : { discarded: result === "discarded" });
  };
}
