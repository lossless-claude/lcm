import type { ServerResponse } from "node:http";
import { sendJson } from "./server.js";
import type { ContextWindowStatus, readCompactionContext } from "./compaction-context.js";

type Stage = { status: string; reason?: string };
export type CompactionReplyBody = {
  renderedContext?: Awaited<ReturnType<typeof readCompactionContext>>;
  captureOutcome?: Stage;
  summaryOutcome?: Stage;
  reason?: string;
  replayOutcome?: string;
  [field: string]: unknown;
};

const REASON_STATUS: Readonly<Record<string, ContextWindowStatus>> = {
  "worker-excluded": "excluded", "timeline-excluded": "excluded",
  busy: "busy", disabled: "no-summarizer", deadline: "deadline",
  "boundary-scan-limit": "boundary-scan-limit",
};

function failureStatus(code: number, body: CompactionReplyBody): ContextWindowStatus {
  if (code === 400 && !body.captureOutcome) return "invalid-request";
  return body.captureOutcome?.status === "completed" ? "summary-failed" : "capture-unverified";
}

function contextStatus(code: number, body: CompactionReplyBody): ContextWindowStatus {
  const reasons = [body.reason, body.summaryOutcome?.reason, body.captureOutcome?.reason, body.replayOutcome];
  for (const reason of reasons) {
    const status = REASON_STATUS[reason ?? ""];
    if (status) return status;
  }
  if (code >= 400) return failureStatus(code, body);
  return body.captureOutcome?.status === "completed" ? "empty" : "capture-unverified";
}

/** One wire constructor and one response owner, independent of cancellation state. */
export function createCompactionReply(res: ServerResponse, sessionId: unknown, renderContext: boolean) {
  let responded = false;
  return (code: number, body: CompactionReplyBody): boolean => {
    if (responded) return false;
    const { renderedContext, ...payload } = body;
    const outcome = renderedContext ?? { status: contextStatus(code, body) };
    const contextWindow = { version: 1, sessionId, ...outcome };
    responded = true;
    sendJson(res, code, renderContext ? { ...payload, contextWindow } : payload);
    return true;
  };
}
