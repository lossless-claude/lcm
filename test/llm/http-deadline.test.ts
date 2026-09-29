import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";

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

  it("bounds a silent Anthropic request without SDK retries", async () => {
    const { base, requests } = await silentServer();
    const summarize = createAnthropicSummarizer({ model: "m", apiKey: "test", baseURL: `${base}/anthropic`, timeoutMs: DEADLINE_MS });
    await expect(withinBound(summarize("conversation", false))).rejects.toMatchObject({ name: "APIConnectionTimeoutError" });
    expect(requests).toHaveLength(1);
  });
});
