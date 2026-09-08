import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
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

  async function sessionSummarizer(): Promise<LcmSummarizeFn> {
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
    return (await createSummarizer("session", config, store))!;
  }

  it.each([false, true])("renders prompts and records the answering session model (condensed=%s)", async (isCondensed) => {
    const summarize = await sessionSummarizer();
    const onUsage = vi.fn();
    const ctx = { sessionId: "one", isCondensed, depth: isCondensed ? 2 : 0, targetTokens: 1200, onUsage };
    const pending = summarize("conversation", false, ctx);
    const job = await store.next("one");
    expect(job).toMatchObject({ system: LCM_SUMMARIZER_SYSTEM_PROMPT, prompt: buildSummaryPrompt("conversation", false, ctx),
      targetTokens: 1200, maxTokens: resolveMaxOutputTokens(1200), kind: isCondensed ? "condensed" : "leaf", depth: ctx.depth });
    store.answer(job!.id, { text: "  summary  ", providerId: isCondensed ? "session:fork" : "session:haiku",
      usage: { input_tokens: 123, output_tokens: 12, estimated: !isCondensed } });
    await expect(pending).resolves.toBe("summary");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: isCondensed ? "session:fork" : "session:haiku",
      inputTokens: 123, outputTokens: 12, estimated: !isCondensed, tokensUsed: 135 }));
    expect(fallback).not.toHaveBeenCalled();
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
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(20_000);
    else store.answer(job!.id, { error: "model unavailable" });
    await expect(pending).resolves.toBe("fallback summary");
    expect(fallback).toHaveBeenCalledWith("conversation", true, ctx);
    expect(ctx.onUsage).toHaveBeenCalledExactlyOnceWith({ provider: "openai", model: "fallback-model", tokensUsed: 42 });
    expect(store.answer(job!.id, { text: "late session summary" })).toBe("discarded");
  });

  it("uses the client's auto fallback without a session module", async () => {
    codexFallback.mockResolvedValue("codex summary");
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session" } }, {});
    const summarize = (await createSummarizer("session", config))!;
    await expect(summarize("conversation", false, { client: "codex" })).resolves.toBe("codex summary");
    expect(codexFallback).toHaveBeenCalledOnce();
  });
});
