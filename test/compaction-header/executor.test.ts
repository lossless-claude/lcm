import { describe, expect, it, vi } from "vitest";
import { headerExecutor } from "../../hooks/compaction-header.js";
import { sessionOutputBudget } from "../../hooks/model-budget.js";
import { workingHeader } from "./fixtures.js";

const usage = { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 };
const completeJob = { prompt: "window and tail", inputHash: "a".repeat(64), promptHash: "b".repeat(64), maxTokens: 4096 };
const forkJob = { prompt: "fork instructions, excerpts only", inputHash: "c".repeat(64), promptHash: "d".repeat(64) };
function engine() {
  return { session: { model: vi.fn(async () => "claude-session-model-20261001") }, model: {
    fork: vi.fn(async () => ({ isAnswered: true as const, text: JSON.stringify(workingHeader()), usage })),
    complete: vi.fn(async () => ({ isAnswered: true as const, text: JSON.stringify(workingHeader()), usage })),
  } };
}
describe("three-arm header executor", () => {
  it("captures the session model once and uses it for B while C uses Sonnet with identical input and allowances", async () => {
    const $ = engine(), budget = sessionOutputBudget($.session, "session-a", 30);
    const model = await headerExecutor.captureModel($);
    $.session.model.mockResolvedValue("changed-after-cut");
    const pair = await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    expect($.session.model).toHaveBeenCalledTimes(1);
    expect($.model.complete.mock.calls).toEqual([
      [{ model: "claude-session-model-20261001", prompt: completeJob.prompt, maxTokens: 15 }],
      [{ model: "sonnet", prompt: completeJob.prompt, maxTokens: 15 }],
    ]);
    expect(pair.B).toMatchObject({ arm: "B", outcome: "answered", usage, options: { maxTokens: 15 } });
    expect(pair.C).toMatchObject({ arm: "C", outcome: "answered", usage, options: { maxTokens: 15 } });
    expect(budget.snapshot().spent).toBe(6);
  });
  it("starts the fork synchronously before a caller's next step and retains its cache-read usage", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    const deferred = Promise.withResolvers<any>(), order: string[] = [];
    $.model.fork.mockImplementation(() => { order.push("fork"); return deferred.promise; });
    const pending = headerExecutor.fork($, forkJob, { model, budget });
    order.push("next"); expect(order).toEqual(["fork", "next"]);
    expect($.model.fork.mock.calls).toEqual([[{ prompt: forkJob.prompt }]]);
    deferred.resolve({ isAnswered: true, text: JSON.stringify(workingHeader()), usage });
    expect(await pending).toMatchObject({ arm: "A", usage: { cache_read_input_tokens: 100 }, outcome: "answered" });
  });
  it("waits for immutable remainder input and the pending fork without making the caller await the arms", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    const fork = Promise.withResolvers<any>(), ready = Promise.withResolvers<typeof completeJob>();
    $.model.fork.mockImplementation(() => fork.promise);
    const a = headerExecutor.fork($, forkJob, { model, budget });
    const bc = headerExecutor.pair($, ready.promise, { model, budget });
    await Promise.resolve(); expect($.model.complete).not.toHaveBeenCalled();
    ready.resolve(completeJob); await Promise.resolve(); expect($.model.complete).not.toHaveBeenCalled();
    fork.resolve({ isAnswered: false, reason: "nothing-to-fork" });
    expect((await a).outcome).toBe("nothing-to-fork");
    expect((await bc).B.outcome).toBe("answered");
  });
  it.each(["api-error", "empty-reply", "aborted", "nothing-to-fork"])("keeps A's %s outcome without substituting another model", async reason => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    $.model.fork.mockResolvedValue({ isAnswered: false, reason, ...(reason === "nothing-to-fork" ? {} : { usage }),
      ...(reason === "api-error" ? { status: 400, error: "invalid_request" } : {}) } as any);
    const result = await headerExecutor.fork($, forkJob, { model, budget });
    expect(result).toMatchObject({ outcome: reason, usage: reason === "nothing-to-fork" ? null : usage });
    if (reason === "api-error") expect(result).toMatchObject({ status: 400, errorKind: "invalid_request" });
    expect($.model.complete).not.toHaveBeenCalled();
    expect(budget.snapshot().spent).toBe(reason === "nothing-to-fork" ? 0 : 3);
  });
  it("charges invalid JSON output and preserves B's failure independently of C", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    $.model.complete.mockResolvedValueOnce({ isAnswered: true, text: "not JSON", usage });
    const pair = await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    expect(pair.B.outcome).toBe("invalid-output"); expect(pair.C.outcome).toBe("answered");
    expect($.model.complete).toHaveBeenCalledTimes(2); expect(budget.snapshot().spent).toBe(6);
  });
  it("accounts fork overshoot and refuses B/C at the existing cap", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 2);
    expect((await headerExecutor.fork($, forkJob, { model, budget })).outcome).toBe("answered");
    const pair = await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    expect(pair.B.outcome).toBe("spend-cap"); expect(pair.C.outcome).toBe("spend-cap");
    expect(budget.snapshot().overshoot).toBe(1); expect($.model.complete).not.toHaveBeenCalled();
  });
  it("records unavailable input without a completion request", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    const pair = await headerExecutor.pair($, Promise.reject(new Error("source unavailable")), { model, budget });
    expect(pair.B.outcome).toBe("unavailable"); expect(pair.C.outcome).toBe("unavailable");
    expect($.model.complete).not.toHaveBeenCalled(); expect(budget.snapshot().spent).toBe(0);
  });
  it("keeps known spending when another arm has unreported usage, without retaining exception bodies", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 20);
    $.model.complete.mockResolvedValueOnce({ isAnswered: true, text: JSON.stringify(workingHeader()), usage })
      .mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_BODY"));
    const pair = await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    expect(pair.B.outcome).toBe("answered"); expect(pair.C).toMatchObject({ outcome: "unconfirmed", usage: null });
    expect(JSON.stringify(pair)).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(budget.snapshot()).toMatchObject({ spent: 3, usageUnknown: true, available: 0 });
  });
  it("uses the same ledger over two consecutive cuts and refuses calls after exhaustion", async () => {
    const $ = engine(), model = await headerExecutor.captureModel($), budget = sessionOutputBudget($.session, "a", 6);
    await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    const second = await headerExecutor.pair($, Promise.resolve(completeJob), { model, budget });
    expect(second.B.outcome).toBe("spend-cap"); expect(second.C.outcome).toBe("spend-cap");
    expect($.model.complete).toHaveBeenCalledTimes(2);
  });
});
