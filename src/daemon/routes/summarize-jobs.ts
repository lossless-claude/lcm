import { WORKER_JOB_GUIDANCE } from "../../worker-warning.js";
import { sendJson, type RouteHandler } from "../server.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { WORKER_WARNING } from "../../store/worker-store.js";
import { admitWorker } from "../worker-admission.js";
import { SummarizeJobStore, validSummaryProviderId, type SummarizeJob, type JobAnswer } from "../summarize-jobs.js";

export function createNextSummarizeJobHandler(store: SummarizeJobStore, paths?: LcmPaths): RouteHandler {
  return async (req, res) => {
    const query = new URL(req.url!, "http://localhost").searchParams;
    const sessionId = query.get("session_id");
    const workerId = query.get("worker_id");
    if (workerId !== null && (!workerId.trim() || sessionId !== null)) {
      sendJson(res, 400, { error: "provide worker_id or session_id" }); return;
    }
    if (!workerId && !sessionId?.trim()) { sendJson(res, 400, { error: "session_id is required" }); return; }
    const boundInput = Object.fromEntries(query);
    let admission: Awaited<ReturnType<typeof admitWorker>> | undefined;
    if (workerId) {
      try { admission = await admitWorker(paths, boundInput); }
      catch (error) { sendJson(res, 403, { error: (error as Error).message, warning: WORKER_WARNING }); return; }
    }
    const controller = new AbortController();
    let job: SummarizeJob | null = null;
    const release = () => {
      if (job) store.releaseClaim(job.id, workerId ?? undefined);
      job = null;
    };
    const abort = () => {
      controller.abort();
      if (!res.writableFinished) release();
    };
    res.once("close", abort);
    try {
      const wait = query.get("wait_ms") !== "0";
      job = workerId ? await store.nextWorker(workerId, controller.signal, wait, admission!.binding)
        : await store.next(sessionId!, controller.signal, wait);
      if (res.destroyed) { release(); return; }
      if (workerId) {
        await admitWorker(paths, boundInput, (_admission, workers) => {
          if (res.destroyed) { release(); return; }
          // Recorded before the payload leaves: a copy of this result in a transcript is then a copied claim.
          if (job) workers.recordIssuedJob(job.id);
          sendJson(res, 200, { ...(job ? { job } : {}), worker_id: workerId, warning: WORKER_WARNING, guidance: WORKER_JOB_GUIDANCE });
        });
        return;
      }
      if (job) sendJson(res, 200, { job });
      else { res.writeHead(204); res.end(); }
    } catch (error) {
      release();
      if (!workerId) throw error;
      sendJson(res, 403, { error: (error as Error).message, warning: WORKER_WARNING });
    } finally { if (!job || res.writableFinished || res.destroyed) res.off("close", abort); }
  };
}

export function createAnswerSummarizeJobHandler(store: SummarizeJobStore, paths?: LcmPaths): RouteHandler {
  return async (req, res, body) => {
    let answer: JobAnswer & { worker_id?: string; caller_session_id?: string; cwd?: string; client?: string; transport?: string };
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
          validSummaryProviderId(attempt.providerId) && validUsage(attempt.usage) &&
          (attempt.failed === undefined || typeof attempt.failed === "boolean")));
    // Require exactly one outcome and validate accounting before it reaches SQLite.
    if ((answer.text !== undefined && answer.error !== undefined) ||
        (answer.providerId !== undefined && !validSummaryProviderId(answer.providerId)) ||
        (answer.usage !== undefined && !validUsage(answer.usage)) || !validAttempts) {
      sendJson(res, 400, { error: "invalid answer or usage" }); return;
    }
    const id = req.url!.split("?")[0]!.slice("/summarize-jobs/".length);
    const settle = (binding?: string) => {
      const result = store.answer(id, { text: answer.text?.trim(), error: answer.error, providerId: answer.providerId,
        usage: answer.usage, usageAttempts: answer.usageAttempts }, answer.worker_id, binding);
      sendJson(res, result === "missing" ? 404 : 200,
        result === "missing" ? { error: "job not found" } : { discarded: result === "discarded" });
    };
    if (answer.worker_id !== undefined) {
      if (!answer.providerId?.startsWith("session-pool:")) { sendJson(res, 400, { error: "pool provider id is required" }); return; }
      try { await admitWorker(paths, answer as Record<string, unknown>, admission => settle(admission.binding)); }
      catch (error) { sendJson(res, 403, { error: (error as Error).message, warning: WORKER_WARNING }); }
      return;
    }
    settle();
  };
}

/** Submit an isolated pool call; no project store or compaction is opened here. */
export function createPoolSummarizeJobHandler(store: SummarizeJobStore): RouteHandler {
  return async (_req, res, body) => {
    let input: Partial<SummarizeJob> | null;
    try { input = JSON.parse(body); } catch { sendJson(res, 400, { error: "invalid JSON" }); return; }
    if (!input || typeof input !== "object" ||
        typeof input.session_id !== "string" || !input.session_id.trim() ||
        (input.kind !== "leaf" && input.kind !== "condensed") ||
        typeof input.system !== "string" || !input.system.trim() ||
        typeof input.prompt !== "string" || !input.prompt.trim() ||
        !Number.isSafeInteger(input.depth) || input.depth! < 0 ||
        !Number.isSafeInteger(input.targetTokens) || input.targetTokens! <= 0 ||
        !Number.isSafeInteger(input.maxTokens) || input.maxTokens! <= 0) {
      sendJson(res, 400, { error: "invalid pool job" }); return;
    }
    const answer = await store.enqueue({
      session_id: input.session_id, kind: input.kind, depth: input.depth!,
      system: input.system, prompt: input.prompt, targetTokens: input.targetTokens!, maxTokens: input.maxTokens!, pool: true,
    });
    sendJson(res, 200, answer);
  };
}
