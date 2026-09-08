import { describe, it, expect, vi } from "vitest";
import { createOpenAISummarizer } from "../../src/llm/openai.js";

describe("createOpenAISummarizer", () => {
  function makeClient(text = "Summary.") {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: text } }],
          }),
        },
      },
    };
  }

  it("calls OpenAI-compatible endpoint and returns text", async () => {
    const mockClient = makeClient("Summary.");
    const summarizer = createOpenAISummarizer({
      model: "qwen2.5:14b",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    const result = await summarizer("Conversation text", false, { isCondensed: false });
    expect(result).toBe("Summary.");
    expect(mockClient.chat.completions.create).toHaveBeenCalledOnce();
    const args = mockClient.chat.completions.create.mock.calls[0][0];
    expect(args.model).toBe("qwen2.5:14b");
    expect(args.max_tokens).toBe(1024);
    // System prompt is merged into user message for local LLM compatibility
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe("user");
    expect(args.messages[0].content).toContain("context-compaction summarization engine");
  });

  it("sends the previous chunk's summary in the prompt it puts on the wire", async () => {
    const mockClient = makeClient("Summary.");
    const summarizer = createOpenAISummarizer({
      model: "m", baseURL: "http://x/v1", _clientOverride: mockClient as any,
    });
    await summarizer("Conversation text", false, {
      previousSummary: "Earlier the user chose SQLite over Postgres.",
    });
    const args = mockClient.chat.completions.create.mock.calls[0][0];
    expect(args.messages[0].content).toContain("Earlier the user chose SQLite over Postgres.");
  });

  it("sends reasoning verbatim when configured and omits the key otherwise", async () => {
    const withReasoning = makeClient("Summary.");
    await createOpenAISummarizer({
      model: "m",
      baseURL: "http://x/v1",
      reasoning: { effort: "minimal" },
      _clientOverride: withReasoning as any,
    })("Conversation text", false, {});
    expect(withReasoning.chat.completions.create.mock.calls[0][0].reasoning).toEqual({ effort: "minimal" });

    const without = makeClient("Summary.");
    await createOpenAISummarizer({ model: "m", baseURL: "http://x/v1", _clientOverride: without as any })(
      "Conversation text",
      false,
      {},
    );
    expect(without.chat.completions.create.mock.calls[0][0]).not.toHaveProperty("reasoning");
  });

  it("raises max_tokens with the condensed target", async () => {
    const mockClient = makeClient("Summary.");
    const summarizer = createOpenAISummarizer({ model: "m", baseURL: "http://x/v1", _clientOverride: mockClient as any });
    await summarizer("Conversation text", false, { isCondensed: true });
    expect(mockClient.chat.completions.create.mock.calls[0][0].max_tokens).toBe(4000);
  });

  it("retries 3 times on 5xx error then throws", async () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
      _retryDelayMs: 0,
    });
    await expect(summarizer("text", false)).rejects.toThrow("server error");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it("throws immediately on 401 auth error", async () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    const mockClient = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
    };
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    await expect(summarizer("text", false)).rejects.toThrow("auth");
    expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("uses 'local' as apiKey when none provided", async () => {
    const mockClient = makeClient();
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: mockClient as any,
    });
    const result = await summarizer("text", false);
    expect(result).toBe("Summary.");
  });

  it("retries on empty content and then throws instead of echoing the input", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "" } }] });
    const summarizer = createOpenAISummarizer({
      model: "test-model",
      baseURL: "http://localhost:11435/v1",
      _clientOverride: { chat: { completions: { create } } } as any,
      _retryDelayMs: 0,
    });
    await expect(summarizer("x".repeat(600), false)).rejects.toThrow("empty content");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("reports normalized usage, with cached tokens as a subset of the input", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Summary." } }],
      model: "served-model",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 800 },
        cost: 0.0042,
      },
    });
    const onUsage = vi.fn();
    await createOpenAISummarizer({
      model: "requested-model",
      baseURL: "https://openrouter.ai/api/v1",
      _clientOverride: { chat: { completions: { create } } } as any,
    })("Conversation text", false, { onUsage });
    expect(onUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "served-model",
      inputTokens: 1200,
      cachedInputTokens: 800,
      outputTokens: 300,
      tokensUsed: 1500,
      costUsd: 0.0042,
    });
  });

  it("leaves costUsd absent when the server prices nothing, and stays silent without usage", async () => {
    const priced = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Summary." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const onPriced = vi.fn();
    await createOpenAISummarizer({
      model: "m", baseURL: "http://localhost:11435/v1",
      _clientOverride: { chat: { completions: { create: priced } } } as any,
    })("text", false, { onUsage: onPriced });
    expect(onPriced.mock.calls[0][0].costUsd).toBeUndefined();
    expect(onPriced.mock.calls[0][0].tokensUsed).toBe(15);

    const silent = makeClient("Summary.");
    const onSilent = vi.fn();
    await createOpenAISummarizer({
      model: "m", baseURL: "http://localhost:11435/v1", _clientOverride: silent as any,
    })("text", false, { onUsage: onSilent });
    expect(onSilent).not.toHaveBeenCalled();
  });

  it("reports usage for an empty completion, whose tokens were still charged", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "" } }],
      usage: { prompt_tokens: 10, completion_tokens: 900, total_tokens: 910 },
    });
    const onUsage = vi.fn();
    await expect(
      createOpenAISummarizer({
        model: "m", baseURL: "http://x/v1",
        _clientOverride: { chat: { completions: { create } } } as any,
        _retryDelayMs: 0,
      })("x".repeat(600), false, { onUsage }),
    ).rejects.toThrow("empty content");
    expect(onUsage).toHaveBeenCalledTimes(3);
  });

  it("requests cost accounting only from OpenRouter", async () => {
    const router = makeClient("Summary.");
    await createOpenAISummarizer({ model: "m", baseURL: "https://openrouter.ai/api/v1", _clientOverride: router as any })("text", false);
    expect(router.chat.completions.create.mock.calls[0][0].usage).toEqual({ include: true });

    const plain = makeClient("Summary.");
    await createOpenAISummarizer({ model: "m", baseURL: "http://localhost:11435/v1", _clientOverride: plain as any })("text", false);
    expect(plain.chat.completions.create.mock.calls[0][0]).not.toHaveProperty("usage");
  });
});
