import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { withRequestDeadline } from "../../src/llm/http-timeout.js";

const { options } = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock("openai", () => ({ default: class { constructor(opts: unknown) { options(opts); } } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor(opts: unknown) { options(opts); } } }));
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";

const RESPONSE_DELAY_MS = 30;
const HTTP_OK = 200;
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  options.mockClear();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["openai", "anthropic"])("%s uses a transport without fetch's headers/body timeout", async (provider) => {
  // Fail if either adapter falls back to the transport with the 300-second bound.
  const defaultFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw Object.assign(new Error("headers timed out"), { name: "HeadersTimeoutError" });
  });
  const server = createServer((req, res) => {
    expect(req.method).toBe("POST");
    expect(req.headers["x-test"]).toBe("yes");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      expect(body).toBe('{"model":"test"}');
      setTimeout(() => {
        res.writeHead(HTTP_OK, { "content-type": "application/json" });
        res.write('{"ok":');
        setTimeout(() => res.end("true}"), RESPONSE_DELAY_MS);
      }, RESPONSE_DELAY_MS);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  if (provider === "openai") createOpenAISummarizer({ model: "m" });
  else createAnthropicSummarizer({ model: "m", apiKey: "test" });
  const transport = options.mock.calls[0][0].fetch as typeof fetch;
  expect(transport).toBeTypeOf("function");
  expect(transport).not.toBe(globalThis.fetch);
  const response = await transport(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    method: "POST", headers: { "x-test": "yes" }, body: '{"model":"test"}',
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(defaultFetch).not.toHaveBeenCalled();
});

it("aborts the buffered response body at lcm's deadline", async () => {
  createOpenAISummarizer({ model: "m" });
  const transport = options.mock.calls[0][0].fetch as typeof fetch;
  const server = createServer((_req, res) => {
    res.writeHead(HTTP_OK); res.write("unfinished");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await expect(withRequestDeadline(50, ({ signal }) => transport(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`, { signal },
  ))).rejects.toMatchObject({ name: "APIConnectionTimeoutError" });
});
