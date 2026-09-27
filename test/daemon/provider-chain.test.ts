import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { configuredSummaryModel, createSummarizer, firstRunnableSummarizer, logUnavailableEndpoints, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";
import { unavailableEndpoints } from "../../src/daemon/provider-config.js";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import { completion, httpError, startChatCompletionsServer } from "../helpers/chat-completions-server.js";

// A session deadline short enough that a job nobody serves times out within the test.
const SESSION_DEADLINE_MS = 20;
const ENV = { DEEPSEEK_API_KEY: "sk-deepseek", OPENROUTER_API_KEY: "sk-openrouter" };

let server: Awaited<ReturnType<typeof startChatCompletionsServer>>;
beforeAll(async () => { server = await startChatCompletionsServer(); });
afterEach(() => server.reset());
afterAll(() => server.close());

function endpoints() {
  return {
    deepseek: {
      type: "openai", model: "deepseek-chat", baseURL: `${server.base}/deepseek`,
      apiKey: "${DEEPSEEK_API_KEY}", body: { thinking: { type: "disabled" } },
    },
    openrouter: {
      type: "openai", model: "vendor/flash", baseURL: `${server.base}/openrouter`,
      apiKey: "${OPENROUTER_API_KEY}", body: { reasoning: { effort: "minimal" } },
    },
  };
}

async function chain(llm: Record<string, unknown>, jobs?: SummarizeJobStore) {
  const config = loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), ...llm } }, ENV);
  const summarize = await createSummarizer(resolveEffectiveProvider(config), config, jobs);
  if (!summarize) throw new Error("expected a summarizer");
  return summarize;
}

const endpointsCalled = () => server.seen.map((request) => request.endpoint);

describe("summarizer provider chain", () => {
  it("calls DeepSeek first and moves to OpenRouter when DeepSeek's answer stops at the length limit", async () => {
    server.answer("deepseek", completion("The session began with", "length", "deepseek-chat"));
    server.answer("openrouter", completion("the summary", "stop", "vendor/flash"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });
    const onUsage = vi.fn();
    const onFallback = vi.fn();

    await expect(summarize("conversation", false, { onUsage, onFallback })).resolves.toBe("the summary");

    expect(endpointsCalled()).toEqual(["deepseek", "openrouter"]);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith({ reason: expect.stringContaining("summary rejected: deepseek (deepseek-chat)"), fromProvider: "deepseek", toProvider: "openrouter" });
    // Usage is labelled with the endpoint's name, the rejected attempt included.
    expect(onUsage.mock.calls.map(([usage]) => [usage.provider, usage.model]))
      .toEqual([["deepseek", "deepseek-chat"], ["openrouter", "vendor/flash"]]);
  });

  it("sends each endpoint only its own key, URL, model and body", async () => {
    server.answer("deepseek", completion("cut", "length"));
    server.answer("openrouter", completion("the summary"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });

    await summarize("conversation", false, {});

    const [deepseek, openrouter] = server.seen;
    expect(deepseek.authorization).toBe("Bearer sk-deepseek");
    expect(deepseek.body).toMatchObject({ model: "deepseek-chat", thinking: { type: "disabled" } });
    expect(deepseek.body).not.toHaveProperty("reasoning");
    expect(openrouter.authorization).toBe("Bearer sk-openrouter");
    expect(openrouter.body).toMatchObject({ model: "vendor/flash", reasoning: { effort: "minimal" } });
    expect(openrouter.body).not.toHaveProperty("thinking");
    // Generated fields are lcm's, whatever the body holds.
    for (const request of server.seen) {
      expect(request.body.max_tokens).toBeGreaterThanOrEqual(1024);
      expect(request.body.messages).toHaveLength(1);
    }
  });

  it("passes a local Qwen server's chat_template_kwargs through untouched", async () => {
    server.answer("qwen", completion("the summary"));
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "qwen", providers: {
      qwen: { type: "openai", model: "qwen3", baseURL: `${server.base}/qwen`,
        body: { chat_template_kwargs: { enable_thinking: false } } },
    } } }, {});
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;

    await expect(summarize("conversation", false, {})).resolves.toBe("the summary");

    expect(server.seen[0].body).toMatchObject({ model: "qwen3", chat_template_kwargs: { enable_thinking: false } });
  });

  it("hands a job the session does not answer in time to the endpoints, in order", async () => {
    server.answer("deepseek", completion("cut", "length"));
    server.answer("openrouter", completion("the summary"));
    const jobs = new SummarizeJobStore(SESSION_DEADLINE_MS);
    try {
      const summarize = await chain({ provider: "session", fallback: ["deepseek", "openrouter"] }, jobs);
      const onFallback = vi.fn();

      await expect(summarize("conversation", false, { sessionId: "live", onFallback })).resolves.toBe("the summary");

      expect(onFallback.mock.calls.map(([fallback]) => fallback))
        .toEqual([{ reason: "job timeout", fromProvider: "session", toProvider: "deepseek" },
          { reason: expect.stringContaining("summary rejected"), fromProvider: "deepseek", toProvider: "openrouter" }]);
      expect(endpointsCalled()).toEqual(["deepseek", "openrouter"]);
    } finally {
      jobs.close();
    }
  });

  it("moves on after a 401 without retrying the endpoint that refused the key", async () => {
    server.answer("deepseek", httpError(401, "invalid api key"));
    server.answer("openrouter", completion("the summary"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });

    await expect(summarize("conversation", false, {})).resolves.toBe("the summary");

    expect(endpointsCalled()).toEqual(["deepseek", "openrouter"]);
  });

  it("moves on after a 402 without retrying the endpoint whose account cannot pay", async () => {
    server.answer("openrouter", httpError(402, "insufficient credits"));
    server.answer("deepseek", completion("the summary"));
    const summarize = await chain({ provider: "openrouter", fallback: ["deepseek"] });
    const onFallback = vi.fn();

    await expect(summarize("conversation", false, { onFallback })).resolves.toBe("the summary");

    expect(endpointsCalled()).toEqual(["openrouter", "deepseek"]);
    expect(onFallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ fromProvider: "openrouter", toProvider: "deepseek" }));
  });

  it("stops at a 400: a request the endpoint refuses is a configuration error, not a reason to try the next", async () => {
    server.answer("deepseek", httpError(400, "unknown field thinking"));
    server.answer("openrouter", completion("the summary"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });
    const onFallback = vi.fn();

    await expect(summarize("conversation", false, { onFallback })).rejects.toMatchObject({ status: 400 });

    expect(endpointsCalled()).toEqual(["deepseek"]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("throws one error naming every endpoint when all of them fail, each tried once", async () => {
    server.answer("deepseek", completion("cut", "length"));
    server.answer("openrouter", completion("also cut", "length"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });

    const error = await summarize("conversation", false, {}).catch((err: unknown) => err as Error & { failures?: unknown[] });

    expect(error.name).toBe("ProviderChainExhaustedError");
    expect(error.message).toMatch(/deepseek: summary rejected: deepseek .*openrouter: summary rejected: openrouter /s);
    expect(error.failures).toHaveLength(2);
    expect(endpointsCalled()).toEqual(["deepseek", "openrouter"]);
  });

  it("lets LCM_SUMMARY_PROVIDER pick the first endpoint, keeping the rest of the chain", async () => {
    server.answer("openrouter", completion("the summary"));
    const config = loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), provider: "deepseek", fallback: ["openrouter"] } },
      { ...ENV, LCM_SUMMARY_PROVIDER: "openrouter" });

    expect(resolveEffectiveProvider(config)).toBe("openrouter");
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;
    await expect(summarize("conversation", false, {})).resolves.toBe("the summary");
    // openrouter is primary now and listed as a fallback too: it still runs once.
    expect(endpointsCalled()).toEqual(["openrouter"]);
  });
});

describe("the flat llm config, without llm.providers", () => {
  it("still sends llm.reasoning to the one openai endpoint", async () => {
    server.answer("flat", completion("the summary"));
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "openai", model: "m",
      baseURL: `${server.base}/flat`, apiKey: "${KEY}", reasoning: { enabled: false } } }, { KEY: "sk-flat" });
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;
    const onUsage = vi.fn();

    await expect(summarize("conversation", false, { onUsage })).resolves.toBe("the summary");

    expect(server.seen[0].authorization).toBe("Bearer sk-flat");
    expect(server.seen[0].body).toMatchObject({ model: "m", reasoning: { enabled: false } });
    expect(onUsage.mock.calls[0][0].provider).toBe("openai");
  });

  it("keeps the session's fallback on the flat endpoint, labelled by provider type", async () => {
    server.answer("flat", completion("the summary"));
    const jobs = new SummarizeJobStore(SESSION_DEADLINE_MS);
    try {
      const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider: "openai",
        model: "m", baseURL: `${server.base}/flat` } }, {});
      const summarize = (await createSummarizer(resolveEffectiveProvider(config), config, jobs))!;
      const onFallback = vi.fn();

      await expect(summarize("conversation", false, { sessionId: "live", onFallback })).resolves.toBe("the summary");

      expect(onFallback).toHaveBeenCalledExactlyOnceWith({ reason: "job timeout", fromProvider: "session", toProvider: "openai" });
    } finally {
      jobs.close();
    }
  });
});

describe("an endpoint whose key variable is unset", () => {
  const chainOf = (env: Record<string, string>) =>
    loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), provider: "deepseek", fallback: ["openrouter"] } }, env);

  it("loads, drops that endpoint from the chain and summarizes through the rest", async () => {
    server.answer("openrouter", completion("the summary"));
    const config = chainOf({ OPENROUTER_API_KEY: "sk-openrouter" });
    expect(unavailableEndpoints(config.llm)).toEqual([{ name: "deepseek", missingEnv: ["DEEPSEEK_API_KEY"] }]);
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;
    const onFallback = vi.fn();

    await expect(summarize("conversation", false, { onFallback })).resolves.toBe("the summary");

    expect(endpointsCalled()).toEqual(["openrouter"]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("fails the first summary, not the config load, when no endpoint of the chain has its key", async () => {
    const config = chainOf({});
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;

    await expect(summarize("conversation", false, {}))
      .rejects.toThrow(/deepseek.*DEEPSEEK_API_KEY.*openrouter.*OPENROUTER_API_KEY/s);
    expect(server.seen).toHaveLength(0);
  });

  it("writes one warning per unavailable endpoint to the daemon log", () => {
    const write = vi.fn();
    logUnavailableEndpoints({ write } as any, chainOf({}).llm);
    expect(write.mock.calls).toEqual([
      ["warn", "summarizer.endpoint_unavailable", { endpoint: "deepseek", missing_env: ["DEEPSEEK_API_KEY"] }],
      ["warn", "summarizer.endpoint_unavailable", { endpoint: "openrouter", missing_env: ["OPENROUTER_API_KEY"] }],
    ]);
  });
});

describe("configuredSummaryModel", () => {
  it("is the primary endpoint's model with named endpoints, and llm.model in the flat form", () => {
    const named = loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), provider: "deepseek" } }, ENV);
    expect(configuredSummaryModel(named)).toBe("deepseek-chat");
    // With the primary left out for an unset variable, the endpoint that will run first.
    const primaryLeftOut = loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), provider: "deepseek", fallback: ["openrouter"] } },
      { OPENROUTER_API_KEY: "sk" });
    expect(configuredSummaryModel(primaryLeftOut)).toBe("vendor/flash");
    const flat = loadDaemonConfig("/nonexistent", { llm: { provider: "openai", model: "m" } }, {});
    expect(configuredSummaryModel(flat)).toBe("m");
  });
});

describe("the chain's attempt boundary", () => {
  it("announces each link with its configured model before it runs", async () => {
    server.answer("deepseek", httpError(401, "invalid api key"));
    server.answer("openrouter", completion("the summary"));
    const summarize = await chain({ provider: "deepseek", fallback: ["openrouter"] });
    const onAttempt = vi.fn();

    await summarize("conversation", false, { onAttempt });

    expect(onAttempt.mock.calls.map(([attempt]) => attempt)).toEqual([
      { provider: "deepseek", kind: "http", model: "deepseek-chat" },
      { provider: "openrouter", kind: "http", model: "vendor/flash" },
    ]);
  });
});

describe("firstRunnableSummarizer", () => {
  it("is the first runnable link's name and model together", () => {
    const primaryLeftOut = loadDaemonConfig("/nonexistent", { llm: { providers: endpoints(), provider: "deepseek", fallback: ["openrouter"] } },
      { OPENROUTER_API_KEY: "sk" });
    expect(firstRunnableSummarizer(primaryLeftOut)).toEqual({ provider: "openrouter", model: "vendor/flash" });
    const flat = loadDaemonConfig("/nonexistent", { llm: { provider: "openai", model: "m" } }, {});
    expect(firstRunnableSummarizer(flat, "openai")).toEqual({ provider: "openai", model: "m" });
  });
});

it("fails a hand-built flat config naming an unknown provider with a clear error", async () => {
  const config = loadDaemonConfig("/nonexistent", {}, {});
  config.llm.provider = "open-ai";
  await expect(createSummarizer("open-ai", config)).rejects.toThrow(/Unknown summarizer provider "open-ai"/);
});
