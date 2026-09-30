import { describe, expect, it, vi } from "vitest";
import { withEndpointSlot } from "../../src/llm/endpoint-concurrency.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";

const ADMISSION_TIMEOUT_MS = 1000;
const TIMEOUT_MS = 10;
const WAIT_PAST_DEADLINE_MS = 30;

describe("endpoint slot admission", () => {
  it("admits queued live work first and keeps FIFO within each class", async () => {
    let release!: () => void;
    const held = withEndpointSlot("priority", 1, ADMISSION_TIMEOUT_MS, () => new Promise<void>((resolve) => { release = resolve; }));
    const admitted: string[] = [];
    const request = (id: string, workClass: "live" | "background") =>
      withEndpointSlot("priority", 1, ADMISSION_TIMEOUT_MS, async () => { admitted.push(id); }, workClass);
    const queued = [request("background-1", "background"), request("background-2", "background"),
      request("live-1", "live"), request("background-3", "background"), request("live-2", "live")];

    release();
    await Promise.all([held, ...queued]);

    expect(admitted).toEqual(["live-1", "live-2", "background-1", "background-2", "background-3"]);
  });

  it("lets background wait past timeoutMs while live waits remain bounded", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = withEndpointSlot("wait-bounds", 1, TIMEOUT_MS, () => new Promise<void>((resolve) => { release = resolve; }));
    const admitted: string[] = [];
    const background = withEndpointSlot("wait-bounds", 1, TIMEOUT_MS, async () => { admitted.push("background"); }, "background");
    const live = withEndpointSlot("wait-bounds", 1, TIMEOUT_MS, async () => { admitted.push("expired-live"); });
    const outcomes = Promise.allSettled([background, live]);
    try {
      await vi.advanceTimersByTimeAsync(WAIT_PAST_DEADLINE_MS);
      const freshLive = withEndpointSlot("wait-bounds", 1, TIMEOUT_MS, async () => { admitted.push("fresh-live"); });
      release();
      await Promise.all([held, freshLive]);

      expect(await outcomes).toMatchObject([
        { status: "fulfilled" },
        { status: "rejected", reason: { name: "APIConnectionTimeoutError", message: "wait for endpoint wait-bounds slot timed out after 10ms" } },
      ]);
      expect(admitted).toEqual(["fresh-live", "background"]);
    } finally {
      release();
      await Promise.allSettled([held, background, live]);
      vi.useRealTimers();
    }
  });

  it("leaves calls unlimited when maxConcurrent is unset, for either class", async () => {
    let release!: () => void;
    const held = withEndpointSlot("unlimited", undefined, TIMEOUT_MS, () => new Promise<void>((resolve) => { release = resolve; }));
    const admitted: string[] = [];
    try {
      await Promise.all([
        withEndpointSlot("unlimited", undefined, TIMEOUT_MS, async () => { admitted.push("live"); }),
        withEndpointSlot("unlimited", undefined, TIMEOUT_MS, async () => { admitted.push("background"); }, "background"),
      ]);
      expect(admitted).toEqual(["live", "background"]);
    } finally {
      release();
      await held;
    }
  });

  it.each(["openai", "anthropic"])("passes the work class to slot admission in the %s adapter", async (provider) => {
    vi.useFakeTimers();
    let release!: () => void;
    const name = `adapter-${provider}`;
    const held = withEndpointSlot(name, 1, TIMEOUT_MS, () => new Promise<void>((resolve) => { release = resolve; }));
    const create = vi.fn(async (_body: { messages: { content: string }[] }, _options: { timeout: number }) => ({
      choices: [{ message: { content: "summary" }, finish_reason: "stop" }],
      content: [{ type: "text", text: "summary" }], stop_reason: "end_turn",
    }));
    const opts = { label: name, model: "m", apiKey: "test", maxConcurrent: 1, timeoutMs: TIMEOUT_MS };
    const summarize = provider === "openai"
      ? createOpenAISummarizer({ ...opts, _clientOverride: { chat: { completions: { create } } } })
      : createAnthropicSummarizer({ ...opts, _clientOverride: { messages: { create } } });
    const background = summarize("background", false, { workClass: "background" });
    const outcome = Promise.allSettled([background]);
    try {
      await vi.advanceTimersByTimeAsync(WAIT_PAST_DEADLINE_MS);
      const live = summarize("live");
      release();
      await Promise.all([held, live]);

      expect(await outcome).toEqual([{ status: "fulfilled", value: "summary" }]);
      expect(create.mock.calls).toHaveLength(2);
      expect(create.mock.calls[0][0].messages[0].content).toContain("live");
      expect(create.mock.calls[1][0].messages[0].content).toContain("background");
      expect(create.mock.calls[1][1]).toMatchObject({ timeout: TIMEOUT_MS });
    } finally {
      release();
      await Promise.allSettled([held, background]);
      vi.useRealTimers();
    }
  });
});
