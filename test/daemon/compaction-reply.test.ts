import { expect, it, vi } from "vitest";
import { createCompactionReply } from "../../src/daemon/compaction-reply.js";

it("sends exactly one rendered reply, even when the producer was cancelled", async () => {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const reply = createCompactionReply(res as any, "session", true);
  const producer = new AbortController();
  producer.abort();
  try { producer.signal.throwIfAborted(); }
  catch { expect(reply(500, { error: "cancelled", captureOutcome: { status: "failed" } })).toBe(true); }
  expect(reply(408, { reason: "deadline" })).toBe(false);
  expect(res.end).toHaveBeenCalledOnce();
  expect(JSON.parse(res.end.mock.calls[0][0]).contextWindow.status).toBe("capture-unverified");
});

it.each([
  [200, { reason: "worker-excluded" }, "excluded"],
  [200, { replayOutcome: "disabled" }, "no-summarizer"],
  [500, { captureOutcome: { status: "completed" } }, "summary-failed"],
  [408, { reason: "deadline" }, "deadline"],
  [400, { error: "invalid" }, "invalid-request"],
])("renders a typed outcome for reply %s", (code, body, expected) => {
  const res = { writeHead: vi.fn(), end: vi.fn() };
  createCompactionReply(res as any, "session", true)(code as number, body as any);
  expect(JSON.parse(res.end.mock.calls[0][0]).contextWindow).toEqual({ version: 1, sessionId: "session", status: expected });
});
