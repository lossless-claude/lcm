import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";

const DEADLINE_MS = 50;

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
        timer = setTimeout(() => reject(new Error("request exceeded deadline bound")), 700);
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
        next: { type: "openai", model: "m", baseURL: `${base}/next`, timeoutMs: 500 },
      },
    } }, {});
    const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;
    const started = Date.now();

    await expect(withinBound(summarize("conversation", false))).resolves.toBe("fallback summary");
    expect(Date.now() - started).toBeLessThan(700);
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

  it("bounds a silent Anthropic request without SDK retries", async () => {
    const { base, requests } = await silentServer();
    const summarize = createAnthropicSummarizer({ model: "m", apiKey: "test", baseURL: `${base}/anthropic`, timeoutMs: DEADLINE_MS });
    await expect(withinBound(summarize("conversation", false))).rejects.toMatchObject({ name: "APIConnectionTimeoutError" });
    expect(requests).toHaveLength(1);
  });
});
