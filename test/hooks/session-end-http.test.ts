import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { createConnection } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client.js";
import { createDaemon, type DaemonInstance, type RouteHandler } from "../../src/daemon/server.js";
import { createSessionEndHandler } from "../../src/daemon/routes/session-end.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { readHookOutcomeLog } from "../../src/doctor/hook-outcome-log.js";

const fired = vi.hoisted(() => ({ compact: vi.fn(), promote: vi.fn(), promoteEvents: vi.fn(), complete: vi.fn() }));
vi.mock("../../src/hooks/daemon-requests.js", () => ({
  fireCompactRequest: fired.compact,
  firePromoteRequest: fired.promote,
  firePromoteEventsRequest: fired.promoteEvents,
  fireSessionCompleteRequest: fired.complete,
}));

const RESPONSE_GRACE_MS = 100;
const RESPONSE_DELAY_MS = 50;
const HANDOFF_BUDGET_MS = 300;
const DELAYED_TURN_MS = 1000;
const PROCESS_HANG_GUARD_MS = 10_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const event = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

// Freeze hook deadlines while real HTTP reaches each milestone. Native
// AbortSignal.timeout does not use fake timers, so give it the same clock.
// Disable the client's socket timeout to prove the hook's signal cancels HTTP.
const hookClock = (client: DaemonClient) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const post = client.post.bind(client);
  return vi.spyOn(client, "post").mockImplementation((path, body, options = {}) =>
    post(path, body, { ...options, timeoutMs: 0 }));
};

describe("SessionEnd HTTP handoff", () => {
  let home: string;
  let paths: LcmPaths;
  let server: Server | undefined;
  let daemon: DaemonInstance | undefined;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "lcm-session-end-http-")));
    paths = createLcmPaths(home);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await daemon?.stop();
    daemon = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const outcomes = () => readHookOutcomeLog(paths.logsDir, home).outcomes;
  const input = () => JSON.stringify({ session_id: "exit", cwd: home });
  const listen = async (handler: RequestListener) => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { port, client: new DaemonClient(`http://127.0.0.1:${port}`) };
  };

  it("cancels at the response deadline without an answer and records the fully written request as submitted", async () => {
    let received = "";
    const submitted = event();
    const { client, port } = await listen((req, _res) => {
      req.on("data", (chunk) => { received += chunk; });
      req.on("end", submitted.resolve);
      // No answer: a responsive client must leave before a busy daemon can reply.
    });
    const post = hookClock(client);
    let returned = false;
    const result = handleSessionEnd(input(), client, paths, port).then((value) => {
      returned = true;
      return value;
    });
    await submitted.promise;
    const signal = post.mock.calls[0][2]!.signal!;
    await vi.advanceTimersByTimeAsync(RESPONSE_GRACE_MS - 1);
    expect(signal.aborted).toBe(false);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(await result).toEqual({ exitCode: 0, stdout: "" });
    await vi.advanceTimersByTimeAsync(DELAYED_TURN_MS);
    expect(JSON.parse(received)).toEqual(JSON.parse(input()));
    expect(outcomes()).toEqual([expect.objectContaining({ operation: "session-end", status: "submitted", reason: "response-grace" })]);
  });

  it("lets the built hook process exit without waiting for a silent server", async () => {
    const requests: string[] = [];
    const { port } = await listen((req, _res) => { requests.push(req.url!); req.resume(); });
    writeFileSync(paths.configPath, JSON.stringify({ daemon: { port } }));
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/bin/lcm.js", import.meta.url)), "session-end"], {
      env: { ...process.env, LCM_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = setTimeout(() => child.kill(), PROCESS_HANG_GUARD_MS);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(input());
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(requests).toEqual(["/session-end"]);
      expect(outcomes()).toEqual([expect.objectContaining({ status: "submitted" })]);
    } finally { clearTimeout(kill); child.kill(); }
  });

  it("records accepted for a 202 within the grace", async () => {
    const { client, port } = await listen((req, res) => {
      req.resume();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end('{"accepted":true}');
    });
    hookClock(client);
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(outcomes()).toEqual([expect.objectContaining({ status: "accepted" })]);
  });

  it("processes Capture and all follow-ups after a late 202 and a disconnected client", async () => {
    // Hold dispatch until the hook has returned and the server observes closure.
    const config = loadDaemonConfig(paths.configPath, { daemon: { port: 0, idleTimeoutMs: 0 } });
    const ingest = vi.fn<RouteHandler>(async (_req, res, body) => {
      expect(JSON.parse(body)).toEqual(JSON.parse(input()));
      res.writeHead(200);
      res.end('{"ingested":3}');
    });
    const dispatch = event();
    const release = event();
    daemon = await createDaemon(config, { paths });
    const { port } = daemon.address();
    const handler = createSessionEndHandler(config, port, paths, ingest);
    let disconnected = false;
    daemon.registerRoute("POST", "/session-end", async (req, res, body) => {
      const closed = event();
      res.once("close", closed.resolve);
      dispatch.resolve();
      await release.promise;
      await closed.promise;
      disconnected = res.destroyed;
      await handler(req, res, body);
    });
    const client = new DaemonClient(`http://127.0.0.1:${port}`);
    const post = hookClock(client);
    const resultPromise = handleSessionEnd(input(), client, paths, port);
    await dispatch.promise;
    await vi.advanceTimersByTimeAsync(DELAYED_TURN_MS);
    const result = await resultPromise;
    expect(post.mock.calls[0][2]!.signal!.aborted).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
    // Dispatch resumes only after the hook has returned and HTTP has closed.
    const completed = event();
    fired.complete.mockImplementationOnce(completed.resolve);
    release.resolve();
    await completed.promise;
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(disconnected).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(fired.compact).toHaveBeenCalledTimes(1);
    expect(fired.promote).toHaveBeenCalledTimes(1);
    expect(fired.promoteEvents).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([expect.objectContaining({ status: "submitted" })]);
  });

  it("keeps the 404 fallback inside the exit budget when the older daemon's ingest hangs", async () => {
    const requests: string[] = [];
    const sessionEnd = event();
    const ingest = event();
    const { client, port } = await listen((req, res) => {
      requests.push(req.url!);
      req.resume();
      if (req.url === "/session-end") {
        setTimeout(() => {
          res.writeHead(404);
          res.end('{"error":"not found"}');
        }, RESPONSE_DELAY_MS);
        sessionEnd.resolve();
      } else {
        req.on("end", ingest.resolve);
      }
    });
    const post = hookClock(client);
    let returned = false;
    const result = handleSessionEnd(input(), client, paths, port).then((value) => {
      returned = true;
      return value;
    });
    await sessionEnd.promise;
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS);
    await ingest.promise;
    const options = post.mock.calls[1][2]!;
    const remainingMs = HANDOFF_BUDGET_MS - RESPONSE_DELAY_MS;
    expect(options.timeoutMs).toBe(remainingMs);
    await vi.advanceTimersByTimeAsync(remainingMs - 1);
    expect(options.signal!.aborted).toBe(false);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(options.signal!.aborted).toBe(true);
    expect(await result).toEqual({ exitCode: 0, stdout: "" });
    // Assertions remain valid even when their event-loop turn runs late.
    await vi.advanceTimersByTimeAsync(DELAYED_TURN_MS);
    expect(requests).toEqual(["/session-end", "/ingest"]);
    for (const followUp of Object.values(fired)) expect(followUp).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "capture", status: "unconfirmed", reason: "timeout" }),
    ]));
  });

  it("runs the older-daemon fallback when a 404 arrives within the grace", async () => {
    const requests: string[] = [];
    const { client, port } = await listen((req, res) => {
      requests.push(req.url!);
      req.resume();
      res.writeHead(req.url === "/session-end" ? 404 : 200);
      res.end(req.url === "/session-end" ? '{"error":"not found"}' : '{"ingested":2}');
    });
    hookClock(client);
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual(["/session-end", "/ingest"]);
    expect(fired.compact).toHaveBeenCalledTimes(1);
    expect(fired.promote).toHaveBeenCalledTimes(1);
    expect(fired.promoteEvents).toHaveBeenCalledTimes(1);
    expect(fired.complete).toHaveBeenCalledTimes(1);
  });

  it("records submitted without starting the fallback for a 404 after the grace", async () => {
    const requests: string[] = [];
    const received = event();
    const answered = event();
    const { client, port } = await listen((req, res) => {
      requests.push(req.url!);
      req.resume();
      req.on("end", () => {
        received.resolve();
        setTimeout(() => {
          res.writeHead(404);
          res.end('{"error":"not found"}');
          answered.resolve();
        }, RESPONSE_GRACE_MS + RESPONSE_DELAY_MS);
      });
    });
    hookClock(client);
    const result = handleSessionEnd(input(), client, paths, port);
    await received.promise;
    await vi.advanceTimersByTimeAsync(RESPONSE_GRACE_MS);
    expect(await result).toEqual({ exitCode: 0, stdout: "" });
    await vi.advanceTimersByTimeAsync(RESPONSE_DELAY_MS);
    await answered.promise;
    expect(requests).toEqual(["/session-end"]);
    expect(fired.complete).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([expect.objectContaining({ status: "submitted", reason: "response-grace" })]);
  });

  it("ignores a request disconnected before its complete body was sent", async () => {
    const config = loadDaemonConfig(paths.configPath, { daemon: { port: 0, idleTimeoutMs: 0 } });
    daemon = await createDaemon(config, { paths });
    const { port } = daemon.address();
    const ingest = vi.fn<RouteHandler>();
    daemon.registerRoute("POST", "/session-end", createSessionEndHandler(config, port, paths, ingest));
    const socket = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write('POST /session-end HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{"session_id":"exit"}');
    await delay(20);
    socket.destroy();
    await delay(30);
    expect(ingest).not.toHaveBeenCalled();
    expect(fired.complete).not.toHaveBeenCalled();
  });

  it("exits immediately on a refused connection without a health probe or spawn", async () => {
    const { client, port } = await listen((_req, res) => { res.end(); });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    hookClock(client);
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    await vi.advanceTimersByTimeAsync(DELAYED_TURN_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(outcomes()).toEqual([expect.objectContaining({ status: "unconfirmed", reason: "daemon-unavailable" })]);
  });
});
