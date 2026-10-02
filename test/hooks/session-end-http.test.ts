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
import { noopDaemonLog } from "../../src/daemon/log.js";
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

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  it("returns in under 500 ms without an answer and records the fully written request as submitted", async () => {
    let received = "";
    const { client, port } = await listen((req, _res) => {
      req.on("data", (chunk) => { received += chunk; });
      // No answer: a responsive client must leave before a busy daemon can reply.
    });
    const started = performance.now();
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(JSON.parse(received)).toEqual(JSON.parse(input()));
    expect(outcomes()).toEqual([expect.objectContaining({ operation: "session-end", status: "submitted" })]);
  });

  it("lets the built hook process exit inside the host budget while the server stays silent", async () => {
    const requests: string[] = [];
    const { port } = await listen((req, _res) => { requests.push(req.url!); req.resume(); });
    writeFileSync(paths.configPath, JSON.stringify({ daemon: { port } }));
    const started = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/bin/lcm.js", import.meta.url)), "session-end"], {
      env: { ...process.env, LCM_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    const kill = setTimeout(() => child.kill(), 2000);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(input());
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      expect(code).toBe(0);
      expect(performance.now() - started).toBeLessThan(1500);
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
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(outcomes()).toEqual([expect.objectContaining({ status: "accepted" })]);
  });

  it("processes Capture and all follow-ups after a late 202 and a disconnected client", async () => {
    // Hold dispatch after the real server has read the complete body, modeling a
    // busy daemon whose loop cannot acknowledge the hook for several seconds.
    const config = loadDaemonConfig(paths.configPath, { daemon: { port: 0, idleTimeoutMs: 0 } });
    const ingest = vi.fn<RouteHandler>(async (_req, res, body) => {
      expect(JSON.parse(body)).toEqual(JSON.parse(input()));
      res.writeHead(200);
      res.end('{"ingested":3}');
    });
    daemon = await createDaemon(config, { paths, log: { ...noopDaemonLog, prepare: async () => { await delay(3000); } } });
    const { port } = daemon.address();
    const handler = createSessionEndHandler(config, port, paths, ingest);
    let disconnected = false;
    daemon.registerRoute("POST", "/session-end", async (req, res, body) => {
      disconnected = res.destroyed;
      await handler(req, res, body);
    });
    const started = performance.now();
    const result = await handleSessionEnd(input(), new DaemonClient(`http://127.0.0.1:${port}`), paths, port);
    const elapsed = performance.now() - started;
    await vi.waitFor(() => expect(fired.complete).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(elapsed).toBeLessThan(500);
    expect(disconnected).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(fired.compact).toHaveBeenCalledTimes(1);
    expect(fired.promote).toHaveBeenCalledTimes(1);
    expect(fired.promoteEvents).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([expect.objectContaining({ status: "submitted" })]);
  });

  it("keeps the 404 fallback inside the exit budget when the older daemon's ingest hangs", async () => {
    const requests: string[] = [];
    const { client, port } = await listen((req, res) => {
      requests.push(req.url!);
      req.resume();
      if (req.url === "/session-end") {
        res.writeHead(404);
        res.end('{"error":"not found"}');
      }
    });
    const started = performance.now();
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(requests).toEqual(["/session-end", "/ingest"]);
    expect(fired.complete).not.toHaveBeenCalled();
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
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(requests).toEqual(["/session-end", "/ingest"]);
    expect(fired.compact).toHaveBeenCalledTimes(1);
    expect(fired.promote).toHaveBeenCalledTimes(1);
    expect(fired.promoteEvents).toHaveBeenCalledTimes(1);
    expect(fired.complete).toHaveBeenCalledTimes(1);
  });

  it("records submitted without starting the fallback for a 404 after the grace", async () => {
    const requests: string[] = [];
    let answer: Promise<void> = Promise.resolve();
    const { client, port } = await listen((req, res) => {
      requests.push(req.url!);
      req.resume();
      answer = delay(250).then(() => { res.writeHead(404); res.end('{"error":"not found"}'); });
    });
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    await answer;
    expect(requests).toEqual(["/session-end"]);
    expect(fired.complete).not.toHaveBeenCalled();
    expect(outcomes()).toEqual([expect.objectContaining({ status: "submitted" })]);
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
    const started = performance.now();
    expect(await handleSessionEnd(input(), client, paths, port)).toEqual({ exitCode: 0, stdout: "" });
    expect(performance.now() - started).toBeLessThan(200);
    expect(outcomes()).toEqual([expect.objectContaining({ status: "unconfirmed", reason: "daemon-unavailable" })]);
  });
});
