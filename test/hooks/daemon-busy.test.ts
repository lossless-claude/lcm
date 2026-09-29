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

/** A scripted answer: an HTTP status, or a failure that arrives after `afterMs`. */
type Answer = { status: number } | { error: unknown; afterMs?: number };
const refused = { error: { code: "ECONNREFUSED", message: "fetch failed" } };
const heldUntilTimeout = { error: new DOMException("timed out", "TimeoutError"), afterMs: HOST_REQUEST_CAP_MS };

/**
 * session.start with a scripted `/health` probe and `/summarize-jobs/next` polls; the poller
 * parks once its script runs out. `hostEnvMs` is how long each host-environment read takes.
 */
async function startSession(script: { health: Answer; polls: Answer[]; hostEnvMs?: number }) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let elapsed = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);
  const answer = async (step: Answer) => {
    if ("status" in step) return { ok: step.status < 300, status: step.status, text: "" };
    elapsed += step.afterMs ?? 0;
    throw step.error;
  };
  let parked!: () => void;
  const pollerParked = new Promise<void>((resolve) => { parked = resolve; });
  const engine = {
    session: { id: vi.fn(async () => "session-1"), cwd: vi.fn(async () => "/proj") },
    process: { run: vi.fn(async (args: string[]) => {
      if (!args[2].includes("__CONFIG__")) return { stdout: "", stderr: "", exitCode: 0 };
      elapsed += script.hostEnvMs ?? 0;
      return { stdout: "\n__CONFIG__\n{}\n__TMPDIR__\n/tmp", exitCode: 0 };
    }) },
    fs: { write: vi.fn(async () => undefined) },
    clock: { after: vi.fn((_ms: number, callback: () => void) => callback()), sleep: vi.fn(async () => undefined) },
    ui: { log: vi.fn() },
    http: { fetch: vi.fn(async (url: string) => {
      if (url.endsWith("/health")) return answer(script.health);
      if (!url.includes("/summarize-jobs/next")) return { ok: true, status: 200, text: "{}" };
      const step = script.polls.shift();
      if (step) return answer(step);
      parked();
      return new Promise(() => {});
    }) },
  };
  const { register } = await import("../../hooks/lcm-hooks.js");
  register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, {});
  await handlers.get("session.start")!(engine, {}, vi.fn(async (event: unknown) => event));
  await pollerParked;
  // The health probe is fire-and-forget; let its failure handler finish.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return engine.process.run.mock.calls.filter(([args]) => args[2].includes("lcm daemon start")).length;
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

  it("neither starts nor retries after a listener answers 200 with a body that is not JSON", async () => {
    const { engine, fire } = await harness(new Error("unused"));
    engine.http.fetch.mockReset().mockResolvedValue({ ok: true, status: 200, text: "not json" });
    await fire();
    expect(engine.http.fetch).toHaveBeenCalledTimes(1);
    expect(engine.process.run).toHaveBeenCalledTimes(1); // host environment only
  });

  it.each([
    ["starts the daemon after a refused health probe", refused, 1],
    ["leaves a health probe that timed out on a listener", heldUntilTimeout, 0],
  ])("session.start %s", async (_label, health, starts) => {
    expect(await startSession({ health, polls: [] })).toBe(starts);
  });

  it.each([
    ["starts the daemon after a refused poll", refused, 1],
    ["leaves a poll that timed out on a listener", heldUntilTimeout, 0],
  ])("the summary poller %s", async (_label, poll, starts) => {
    expect(await startSession({ health: { status: 200 }, polls: [poll] })).toBe(starts);
  });

  it("times a poll from its request, not from a slow host-environment read", async () => {
    // A 401 clears the cached environment, so the next poll reads it again first.
    const polls = [{ status: 401 }, { error: new Error("fetch failed") }];
    expect(await startSession({ health: { status: 200 }, polls, hostEnvMs: HOST_REQUEST_CAP_MS })).toBe(1);
  });
});
