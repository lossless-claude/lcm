import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";

describe("named HTTP endpoint concurrency", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // HTTP stays real, but answers and deadline turns belong to the test.
  function endpointClock() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }

  async function countingServer() {
    let active = 0;
    let peak = 0;
    const paths: string[] = [];
    const answers: Array<() => void> = [];
    const waiters: Array<{ count: number; resolve: () => void }> = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        paths.push(req.url ?? "");
        active++;
        peak = Math.max(peak, active);
        answers.push(() => {
          res.writeHead(200, { "content-type": "application/json" });
          const content = req.url?.startsWith("/fallback/") ? "fallback summary" : "summary";
          res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
          active--;
        });
        for (const waiter of waiters.splice(0)) {
          if (paths.length >= waiter.count) waiter.resolve();
          else waiters.push(waiter);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      get peak() { return peak; },
      get received() { return paths.length; },
      paths,
      waitForRequests(count: number) {
        if (paths.length >= count) return Promise.resolve();
        return new Promise<void>((resolve) => { waiters.push({ count, resolve }); });
      },
      answer(index: number) { answers[index](); },
    };
  }

  async function summarizer(name: string, baseURL: string, maxConcurrent?: number, timeoutMs = 1000) {
    const config = loadDaemonConfig("/nonexistent", { llm: {
      provider: name,
      providers: { [name]: { type: "openai", model: "m", baseURL, timeoutMs, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) } },
    } }, {});
    return (await createSummarizer(name, config))!;
  }

  it("sends parallel summaries one at a time when maxConcurrent is one", async () => {
    endpointClock();
    const server = await countingServer();
    const summarize = await summarizer("serial", server.baseURL, 1);

    const results = Promise.all(Array.from({ length: 4 }, () => summarize("conversation")));
    for (let index = 0; index < 4; index++) {
      await server.waitForRequests(index + 1);
      server.answer(index);
    }
    await expect(results).resolves.toEqual(["summary", "summary", "summary", "summary"]);
    expect(server.received).toBe(4);
    expect(server.peak).toBe(1);
  });

  it("shares the named endpoint limit across summarizer instances", async () => {
    endpointClock();
    const server = await countingServer();
    const first = await summarizer("shared", server.baseURL, 1);
    const second = await summarizer("shared", server.baseURL, 1);

    const results = Promise.all([first("one"), second("two"), first("three")]);
    for (let index = 0; index < 3; index++) {
      await server.waitForRequests(index + 1);
      server.answer(index);
    }
    await expect(results).resolves.toEqual(["summary", "summary", "summary"]);
    expect(server.peak).toBe(1);
  });

  it("starts each request deadline after its slot wait", async () => {
    endpointClock();
    const server = await countingServer();
    const summarize = await summarizer("deadline", server.baseURL, 1, 130);

    const first = summarize("one");
    const second = summarize("two");
    const results = Promise.all([first, second]);
    await server.waitForRequests(1);
    await vi.advanceTimersByTimeAsync(80);
    server.answer(0);
    expect(await first).toBe("summary");
    await server.waitForRequests(2);
    // Total time exceeds 130 ms; each request and the slot wait stay below it.
    await vi.advanceTimersByTimeAsync(80);
    server.answer(1);
    await expect(results).resolves.toEqual(["summary", "summary"]);
    expect(server.peak).toBe(1);
  });

  it("keeps the unlimited behavior when maxConcurrent is unset", async () => {
    endpointClock();
    const server = await countingServer();
    const summarize = await summarizer("unlimited", server.baseURL);

    const results = Promise.all([summarize("one"), summarize("two"), summarize("three")]);
    await server.waitForRequests(3);
    for (let index = 0; index < 3; index++) server.answer(index);
    await expect(results).resolves.toEqual(["summary", "summary", "summary"]);
    expect(server.peak).toBe(3);
  });

  it("advances the provider chain when a queued call waits too long", async () => {
    endpointClock();
    const server = await countingServer();
    const config = loadDaemonConfig("/nonexistent", { llm: {
      provider: "serial", fallback: ["fallback"], providers: {
        serial: { type: "openai", model: "m", baseURL: server.baseURL, timeoutMs: 120, maxConcurrent: 1 },
        fallback: { type: "openai", model: "m", baseURL: server.baseURL.replace("/v1", "/fallback"), timeoutMs: 120 },
      },
    } }, {});
    const summarize = (await createSummarizer("serial", config))!;

    const first = summarize("one");
    const second = summarize("two");
    const third = summarize("three");
    const results = Promise.all([first, second, third]);
    await server.waitForRequests(1);
    await vi.advanceTimersByTimeAsync(70);
    server.answer(0);
    expect(await first).toBe("summary");
    await server.waitForRequests(2);
    expect(server.paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    // The second call owns the slot; only the third is still queued at 120 ms.
    await vi.advanceTimersByTimeAsync(49);
    expect(server.received).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await server.waitForRequests(3);
    expect(server.paths[2]).toBe("/fallback/chat/completions");
    server.answer(2);
    expect(await third).toBe("fallback summary");
    server.answer(1);
    await expect(results).resolves.toEqual(["summary", "summary", "fallback summary"]);
    expect(server.paths.filter((path) => path.startsWith("/v1/"))).toHaveLength(2);
    expect(server.paths.filter((path) => path.startsWith("/fallback/"))).toHaveLength(1);
  });
});
