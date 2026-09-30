import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POOL_COMPLETION_MS, SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { buildSummaryPrompt } from "../../src/llm/prompt.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT, resolveMaxOutputTokens } from "../../src/summarize.js";
import type { LcmSummarizeFn } from "../../src/llm/types.js";

const { fallback, codexFallback } = vi.hoisted(() => ({ fallback: vi.fn(), codexFallback: vi.fn() }));
vi.mock("../../src/llm/openai.js", () => ({ createOpenAISummarizer: () => fallback }));
vi.mock("../../src/llm/codex-process.js", () => ({ createCodexProcessSummarizer: () => codexFallback }));

const input = { session_id: "one", kind: "leaf" as const, depth: 0, system: "system", prompt: "prompt", targetTokens: 1000, maxTokens: 2000 };

describe("session summarize jobs", () => {
  let store: SummarizeJobStore;
  beforeEach(() => { vi.useFakeTimers(); store = new SummarizeJobStore(); });
  afterEach(() => { store.close(); vi.useRealTimers(); vi.clearAllMocks(); });

  it("delivers concurrent jobs in FIFO order only to the matching session", async () => {
    const firstAnswer = store.enqueue(input);
    const secondAnswer = store.enqueue({ ...input, prompt: "second" });
    const otherSession = store.next("other");
    const first = await store.next("one");
    const second = await store.next("one");
    expect(first?.prompt).toBe("prompt");
    expect(second?.prompt).toBe("second");
    expect(first?.id).not.toBe(second?.id);
    store.answer(first!.id, { text: "first summary" });
    store.answer(second!.id, { text: "second summary" });
    await expect(firstAnswer).resolves.toEqual({ text: "first summary" });
    await expect(secondAnswer).resolves.toEqual({ text: "second summary" });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(otherSession).resolves.toBeNull();
  });

  it("replaces an old waiter and wakes only the replacement", async () => {
    const old = store.next("one");
    const current = store.next("one");
    await expect(old).resolves.toBeNull();
    void store.enqueue(input);
    await expect(current).resolves.toMatchObject(input);
  });

  it("claims pool jobs exactly once, with one in flight per worker and no normal-session delivery", async () => {
    const first = store.nextWorker("worker-1");
    const second = store.nextWorker("worker-2");
    const answers = [store.enqueue({ ...input, pool: true }), store.enqueue({ ...input, pool: true, prompt: "second" })];
    const jobs = await Promise.all([first, second]);
    expect(new Set(jobs.map((job) => job!.id)).size).toBe(2);
    expect(jobs.map((job) => job!.prompt)).toEqual(["prompt", "second"]);
    const third = store.enqueue({ ...input, pool: true, prompt: "third" });
    await expect(store.nextWorker("worker-1", undefined, false)).resolves.toBeNull();
    await expect(store.next("one", undefined, false)).resolves.toBeNull();
    jobs.forEach((job) => store.answer(job!.id, { text: "summary" }));
    const next = await store.nextWorker("worker-1");
    expect(next!.prompt).toBe("third");
    expect(store.answer(jobs[0]!.id, { text: "duplicate" })).toBe("discarded");
    store.answer(next!.id, { text: "third summary" });
    await expect(Promise.all([...answers, third])).resolves.toHaveLength(3);
  });

  it("expires queued jobs and removes finished entries after a minute", async () => {
    const pending = store.enqueue(input);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toEqual({ error: "job timeout" });
    const next = store.next("one");
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(next).resolves.toBeNull();
    void store.enqueue(input);
    const job = await store.next("one");
    expect(store.answer(job!.id, { text: "done" })).toBe("accepted");
    expect(store.answer(job!.id, { text: "duplicate" })).toBe("discarded");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.answer(job!.id, { text: "late" })).toBe("missing");
  });

  it("removes an aborted waiter without claiming a later job", async () => {
    const controller = new AbortController();
    const waiting = store.next("one", controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeNull();
    void store.enqueue(input);
    await expect(store.next("one")).resolves.toMatchObject(input);
  });

  async function sessionSummarizer(language?: string): Promise<LcmSummarizeFn> {
    const overrides: Record<string, unknown> = {
      llm: { provider: "session", fallbackProvider: "openai" },
    };
    if (language) overrides.summarizer = { language };
    const config = loadDaemonConfig("/nonexistent", overrides, {});
    return (await createSummarizer("session", config, store))!;
  }

  it("gives a claimed pool job the completion deadline, so a slow worker answer is still used", async () => {
    const answer = store.enqueue({ ...input, pool: true });
    const job = await store.nextWorker("worker-1");
    await vi.advanceTimersByTimeAsync(POOL_COMPLETION_MS / 3);
    expect(store.answer(job!.id, { text: "slow summary" })).toBe("accepted");
    await expect(answer).resolves.toEqual({ text: "slow summary" });
    const stuck = store.enqueue({ ...input, pool: true, prompt: "stuck" });
    await store.nextWorker("worker-1");
    await vi.advanceTimersByTimeAsync(POOL_COMPLETION_MS);
    await expect(stuck).resolves.toEqual({ error: "job timeout" });
  });

  it.each([false, true])("gives a session job a fresh 60-second completion window after claim (waiting poller=%s)", async (waitingPoller) => {
    const polling = waitingPoller ? store.next("one") : undefined;
    const answer = store.enqueue(input);
    if (!waitingPoller) await vi.advanceTimersByTimeAsync(19_000);
    const job = await (polling ?? store.next("one"));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(store.answer(job!.id, { text: "slow session summary" })).toBe("accepted");
    await expect(answer).resolves.toEqual({ text: "slow session summary" });
  });

  it("expires a claimed session job at its completion deadline and discards late answers", async () => {
    const answer = store.enqueue(input);
    await vi.advanceTimersByTimeAsync(19_000);
    const job = await store.next("one");
    const settled = vi.fn();
    void answer.then(settled);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toEqual({ error: "job timeout" });
    expect(store.answer(job!.id, { text: "late" })).toBe("discarded");
  });

  it("routes session-pool to any worker and falls along the chain when nobody claims it", async () => {
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
    const summarize = (await createSummarizer("session-pool", config, store))!;
    const pending = summarize("foreign conversation", false, { sessionId: "closed-session", isCondensed: true });
    const job = await store.nextWorker("worker");
    expect(job).toMatchObject({ session_id: "closed-session", pool: true, kind: "condensed" });
    store.answer(job!.id, { text: "worker summary", providerId: "session-pool:sonnet" });
    await expect(pending).resolves.toBe("worker summary");
    fallback.mockResolvedValueOnce("fallback summary");
    const unclaimed = summarize("next conversation", false, { sessionId: "another-closed-session" });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(unclaimed).resolves.toBe("fallback summary");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it.each([false, true])("renders prompts and records the answering session model (condensed=%s)", async (isCondensed) => {
    const summarize = await sessionSummarizer();
    const onUsage = vi.fn();
    const ctx = { sessionId: "one", isCondensed, depth: isCondensed ? 2 : 0, targetTokens: 1200, onUsage };
    const pending = summarize("conversation", false, ctx);
    const job = await store.next("one");
    expect(job).toMatchObject({ system: LCM_SUMMARIZER_SYSTEM_PROMPT, prompt: buildSummaryPrompt("conversation", false, ctx),
      targetTokens: 1200, maxTokens: resolveMaxOutputTokens(1200), kind: isCondensed ? "condensed" : "leaf", depth: ctx.depth });
    await vi.advanceTimersByTimeAsync(23_000);
    store.answer(job!.id, { text: "  summary  ", providerId: isCondensed ? "session:fork" : "session:haiku",
      usage: { input_tokens: 123, output_tokens: 12, estimated: !isCondensed } });
    await expect(pending).resolves.toBe("summary");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: isCondensed ? "session:fork" : "session:haiku",
      inputTokens: 123, outputTokens: 12, estimated: !isCondensed, tokensUsed: 135 }));
    expect(fallback).not.toHaveBeenCalled();
  });

  it("records a failed fork's usage under fork before the fallback answer", async () => {
    const summarize = await sessionSummarizer();
    const onUsage = vi.fn();
    const pending = summarize("conversation", false, { sessionId: "one", isCondensed: true, onUsage });
    const job = await store.next("one");
    store.answer(job!.id, {
      text: "summary", providerId: "session:haiku",
      usage: { input_tokens: 3, output_tokens: 2, estimated: true },
      usageAttempts: [{ providerId: "session:fork",
        usage: { input_tokens: 40, output_tokens: 7, estimated: false }, failed: true }],
    });
    await expect(pending).resolves.toBe("summary");
    expect(onUsage.mock.calls.map(([usage]) => usage)).toEqual([
      expect.objectContaining({ provider: "session:fork", inputTokens: 40, outputTokens: 7, estimated: false, failed: true }),
      expect.objectContaining({ provider: "session:haiku", inputTokens: 3, outputTokens: 2, estimated: true }),
    ]);
  });

  it("keeps an answered attempt distinct when its summary is discarded by the cap", async () => {
    fallback.mockResolvedValueOnce("fallback summary");
    const summarize = await sessionSummarizer();
    const onUsage = vi.fn();
    const pending = summarize("conversation", false, { sessionId: "one", onUsage });
    const job = await store.next("one");
    store.answer(job!.id, { error: "spend cap", usageAttempts: [{ providerId: "session:haiku",
      usage: { input_tokens: 3, output_tokens: 2, estimated: true }, failed: false }] });
    await expect(pending).resolves.toBe("fallback summary");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "session:haiku", failed: false }));
  });

  it("applies the configured language to session summarization jobs", async () => {
    const summarize = await sessionSummarizer("pt-BR");
    const pending = summarize("conversation", false, { sessionId: "one" });
    const job = await store.next("one");
    expect(job?.prompt).toContain("- Write the summary in pt-BR.");
    store.answer(job!.id, { text: "summary" });
    await expect(pending).resolves.toBe("summary");
  });

  it.each(["timeout", "error"])("uses configured fallback and its usage on %s, discarding late answers", async (outcome) => {
    fallback.mockImplementation(async (_text, _aggressive, ctx) => {
      ctx.onUsage({ provider: "openai", model: "fallback-model", tokensUsed: 42 });
      return "fallback summary";
    });
    const summarize = await sessionSummarizer();
    const ctx = { sessionId: "one", onUsage: vi.fn() };
    const pending = summarize("conversation", true, ctx);
    const job = await store.next("one");
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(60_000);
    else store.answer(job!.id, { error: "model unavailable" });
    await expect(pending).resolves.toBe("fallback summary");
    expect(fallback).toHaveBeenCalledWith("conversation", true, ctx);
    expect(ctx.onUsage).toHaveBeenCalledExactlyOnceWith({ provider: "openai", model: "fallback-model", tokensUsed: 42 });
    expect(store.answer(job!.id, { text: "late session summary" })).toBe("discarded");
  });

  it("sends a rejected session answer to the fallback like an error, keeping the session's usage", async () => {
    fallback.mockResolvedValue("fallback summary");
    const summarize = await sessionSummarizer();
    const onUsage = vi.fn();
    const onFallback = vi.fn();
    const pending = summarize("conversation", false, { sessionId: "one", isCondensed: true, depth: 1, onUsage, onFallback });
    const job = await store.next("one");
    store.answer(job!.id, { text: " \n ", providerId: "session:fork",
      usage: { input_tokens: 900, output_tokens: 700, estimated: false } });
    await expect(pending).resolves.toBe("fallback summary");
    expect(fallback).toHaveBeenCalledOnce();
    // The fork charged for its answer even though it was rejected.
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "session:fork", inputTokens: 900, outputTokens: 700 }));
    expect(onFallback).toHaveBeenCalledWith({ reason: expect.stringContaining("summary rejected"), fromProvider: "session", toProvider: "openai" });
  });

  it("does not fall back from a rejected fallback answer: both failures reach the caller", async () => {
    const { SummaryRejectedError } = await import("../../src/llm/summary-rejection.js");
    const rejection = new SummaryRejectedError({ reason: "length", provider: "openai" });
    fallback.mockRejectedValue(rejection);
    const summarize = await sessionSummarizer();
    const pending = summarize("conversation", false, { sessionId: "one" });
    const job = await store.next("one");
    store.answer(job!.id, { error: "model unavailable" });
    await expect(pending).rejects.toMatchObject({ name: "ProviderChainExhaustedError",
      failures: [{ provider: "session", error: expect.objectContaining({ message: "model unavailable" }) },
        { provider: "openai", error: rejection }] });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("uses the client's auto fallback without a session module", async () => {
    codexFallback.mockResolvedValue("codex summary");
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session" } }, {});
    const summarize = (await createSummarizer("session", config))!;
    await expect(summarize("conversation", false, { client: "codex" })).resolves.toBe("codex summary");
    expect(codexFallback).toHaveBeenCalledOnce();
  });
});
