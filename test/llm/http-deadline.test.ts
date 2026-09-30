import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";
import { withRequestDeadline } from "../../src/llm/http-timeout.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";

const DEADLINE_MS = 200;
/** Catches an unbounded request; the request counts prove there were no retries. Below vitest's 5 s test timeout. */
const BOUND_MS = 3_000;

describe("HTTP summarizer deadlines", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function silentServer() {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url?.startsWith("/next/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "fallback summary" } }] }));
      }
      // All other requests are accepted and never answered.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  async function withinBound<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("request exceeded deadline bound")), BOUND_MS);
      })]);
    } finally {
      clearTimeout(timer!);
    }
  }

  it("moves from a silent OpenAI endpoint to the next endpoint after one bounded request", async () => {
    const { base, requests } = await silentServer();
    const config = loadDaemonConfig("/nonexistent", { llm: {
      provider: "silent", fallback: ["next"], providers: {
        silent: { type: "openai", model: "m", baseURL: `${base}/silent`, timeoutMs: DEADLINE_MS },
        next: { type: "openai", model: "m", baseURL: `${base}/next`, timeoutMs: BOUND_MS },
      },
    } }, {});
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;

    await expect(withinBound(summarize("conversation", false))).resolves.toBe("fallback summary");
    expect(requests.filter((path) => path.startsWith("/silent/"))).toHaveLength(1);
    expect(requests.filter((path) => path.startsWith("/next/"))).toHaveLength(1);
  });

  it.each([
    ["OpenAI", (create: any, timeoutMs?: number) => createOpenAISummarizer({
      model: "m", timeoutMs, _retryDelayMs: 0, _clientOverride: { chat: { completions: { create } } },
    }), new OpenAI.APIConnectionTimeoutError()],
    ["Anthropic", (create: any, timeoutMs?: number) => createAnthropicSummarizer({
      model: "m", apiKey: "test", timeoutMs, _retryDelayMs: 0, _clientOverride: { messages: { create } },
    }), new Anthropic.APIConnectionTimeoutError()],
  ])("gives the %s SDK the configured deadline and does not retry its own timeout", async (_label, summarizer, timeout) => {
    const create = vi.fn(async () => { throw timeout; });
    // Above the SDKs' 10-minute default, which would otherwise cut the request first.
    await expect(summarizer(create, 1_200_000)("conversation", false)).rejects.toBe(timeout);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ timeout: 1_200_000 })]);
  });

  it("reports the deadline, not the abort, when the transport rejects as soon as it is aborted", async () => {
    const request = ({ signal }: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await expect(withRequestDeadline(DEADLINE_MS, request)).rejects.toMatchObject({ name: "APIConnectionTimeoutError" });
  });

  it.each(["openai", "anthropic"])("accepts delayed headers and body through the real %s SDK", async (provider) => {
    const responseDelayMs = 30;
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        setTimeout(() => res.end(JSON.stringify(provider === "openai"
          ? { choices: [{ message: { content: "delayed summary" } }] }
          : { content: [{ type: "text", text: "delayed summary" }], stop_reason: "end_turn" }
        ).slice(1)), responseDelayMs);
      }, responseDelayMs);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const opts = { model: "m", apiKey: "test", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 1000 };
    const summarize = provider === "openai" ? createOpenAISummarizer(opts) : createAnthropicSummarizer(opts);
    await expect(summarize("conversation", false)).resolves.toBe("delayed summary");
  });

  it("bounds a silent Anthropic request without SDK retries", async () => {
    const { base, requests } = await silentServer();
    const summarize = createAnthropicSummarizer({ model: "m", apiKey: "test", baseURL: `${base}/anthropic`, timeoutMs: DEADLINE_MS });
    await expect(withinBound(summarize("conversation", false))).rejects.toMatchObject({ name: "APIConnectionTimeoutError" });
    expect(requests).toHaveLength(1);
  });
});
