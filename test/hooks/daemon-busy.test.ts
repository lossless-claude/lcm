import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const HOST_REQUEST_CAP_MS = 5_000;

async function harness(failure: Error) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const engine = {
    session: { id: vi.fn(async () => "session-1"), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async (args: string[]) => args[2].includes("__CONFIG__")
      ? { stdout: "\n__CONFIG__\n{}\n__TMPDIR__\n/tmp", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 }) },
    fs: { write: vi.fn(async () => undefined) },
    clock: { sleep: vi.fn(async () => undefined) },
    ui: { log: vi.fn() },
    http: { fetch: vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ ok: true, status: 200, text: "{}" }) },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
  const fire = () => handlers.get("tool.call")!(engine, { tool: "Read", tool_use_id: "one" },
    vi.fn(async () => ({ result: "ok" })));
  const completeTurn = () => handlers.get("turn.complete")!(engine, {}, vi.fn(async () => ({ done: true })));
  return { engine, fire, completeTurn };
}

describe("function-hook daemon transport failures", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["a Node-shaped refusal", new TypeError("fetch failed", {
      cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })],
    ["a refusal named only in the message", new Error("connect ECONNREFUSED 127.0.0.1:3737")],
    ["an error object from another realm", { code: "ECONNREFUSED", message: "fetch failed" }],
    ["an unnamed failure that came back at once", new Error("fetch failed")],
  ])("starts the daemon and retries on %s", async (_label, error) => {
    const { engine, fire } = await harness(error as Error);
    await fire();
    expect(engine.process.run).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("lcm daemon start")]),
      expect.anything(),
    );
    expect(engine.http.fetch).toHaveBeenCalledTimes(2);
  });

  it("defers a timed out listener without starting or retrying", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const { engine, completeTurn } = await harness(timeout);
    let elapsed = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
    engine.http.fetch.mockReset().mockImplementation(async () => {
      elapsed += HOST_REQUEST_CAP_MS; // the listener held the request until the host gave up
      throw timeout;
    });
    await expect(completeTurn()).resolves.toEqual({ done: true });
    expect(engine.process.run).toHaveBeenCalledTimes(1); // host environment only
    expect(engine.http.fetch).toHaveBeenCalledTimes(2); // ingest and promote, once each
    expect(engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("daemon busy"));
    const snapshot = engine.fs.write.mock.calls.find(([path]) => String(path).includes("lcm-hook-observe-"));
    expect(snapshot).toBeDefined();
    expect(JSON.parse(snapshot![1]).observations).toContainEqual(expect.objectContaining({
      operation: "capture", kind: "delivery", status: "unconfirmed",
    }));
  });

  it("does not restart a listener that accepts a request but never answers", async () => {
    let accepted = 0;
    const server = createServer(() => { accepted++; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const { engine, fire } = await harness(new Error("unused"));
      engine.process.run.mockResolvedValueOnce({
        stdout: `\n__CONFIG__\n{"daemon":{"port":${port}}}\n__TMPDIR__\n/tmp`, exitCode: 0,
      });
      engine.http.fetch.mockReset().mockImplementation(async (url: string, init: RequestInit) => {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1_200) });
        return { ok: response.ok, status: response.status, text: await response.text() };
      });
      await fire();
      expect(accepted).toBe(1);
      expect(engine.http.fetch).toHaveBeenCalledTimes(1);
      expect(engine.process.run).toHaveBeenCalledTimes(1);
      expect(engine.ui.log).toHaveBeenCalledWith(expect.stringContaining("daemon busy"));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
