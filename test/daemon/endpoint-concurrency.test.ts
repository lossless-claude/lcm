import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";

describe("named HTTP endpoint concurrency", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function countingServer(delayMs: number) {
    let active = 0;
    let peak = 0;
    let received = 0;
    const paths: string[] = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        received++;
        paths.push(req.url ?? "");
        active++;
        peak = Math.max(peak, active);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] }));
          active--;
        }, req.url?.startsWith("/fallback/") ? 0 : delayMs);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      get peak() { return peak; },
      get received() { return received; },
      paths,
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
    const server = await countingServer(25);
    const summarize = await summarizer("serial", server.baseURL, 1);

    await expect(Promise.all(Array.from({ length: 4 }, () => summarize("conversation"))))
      .resolves.toEqual(["summary", "summary", "summary", "summary"]);
    expect(server.received).toBe(4);
    expect(server.peak).toBe(1);
  });

  it("shares the named endpoint limit across summarizer instances", async () => {
    const server = await countingServer(25);
    const first = await summarizer("shared", server.baseURL, 1);
    const second = await summarizer("shared", server.baseURL, 1);

    await expect(Promise.all([first("one"), second("two"), first("three")]))
      .resolves.toEqual(["summary", "summary", "summary"]);
    expect(server.peak).toBe(1);
  });

  it("starts each request deadline after its slot wait", async () => {
    const server = await countingServer(80);
    const summarize = await summarizer("deadline", server.baseURL, 1, 130);

    await expect(Promise.all([summarize("one"), summarize("two")]))
      .resolves.toEqual(["summary", "summary"]);
    expect(server.peak).toBe(1);
  });

  it("keeps the unlimited behavior when maxConcurrent is unset", async () => {
    const server = await countingServer(30);
    const summarize = await summarizer("unlimited", server.baseURL);

    await expect(Promise.all([summarize("one"), summarize("two"), summarize("three")]))
      .resolves.toEqual(["summary", "summary", "summary"]);
    expect(server.peak).toBeGreaterThan(1);
  });

  it("advances the provider chain when a queued call waits too long", async () => {
    const server = await countingServer(70);
    const config = loadDaemonConfig("/nonexistent", { llm: {
      provider: "serial", fallback: ["fallback"], providers: {
        serial: { type: "openai", model: "m", baseURL: server.baseURL, timeoutMs: 120, maxConcurrent: 1 },
        fallback: { type: "openai", model: "m", baseURL: server.baseURL.replace("/v1", "/fallback"), timeoutMs: 120 },
      },
    } }, {});
    const summarize = (await createSummarizer("serial", config))!;

    await expect(Promise.all([summarize("one"), summarize("two"), summarize("three")]))
      .resolves.toEqual(["summary", "summary", "summary"]);
    expect(server.paths.filter((path) => path.startsWith("/v1/"))).toHaveLength(2);
    expect(server.paths.filter((path) => path.startsWith("/fallback/"))).toHaveLength(1);
  });
});
