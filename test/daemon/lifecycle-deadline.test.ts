import { createServer, type Server, type Socket, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDaemonHealth, ensureDaemon, stopDaemon } from "../../src/daemon/lifecycle.js";
import { handleSessionStart } from "../../src/hooks/restore.js";
import { dispatchHook } from "../../src/hooks/dispatch.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { lcmHome } from "../../src/lcm-home.js";

const listeners: { server: Server; sockets: Set<Socket> }[] = [];
const dirs: string[] = [];
const sessions: string[] = [];
// Restore uses the real lifecycle, but a regression must never launch a real daemon.
const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: spawnMock,
}));

function pidPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-lifecycle-deadline-"));
  dirs.push(dir);
  return join(dir, "daemon.pid");
}

async function silentListener(): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.resume(); // Accept the request, but never write a response.
  });
  listeners.push({ server, sockets });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function delayedHealthListener(delayMs: number): Promise<number> {
  const sockets = new Set<Socket>();
  const server = createHttpServer((_req, res) => {
    const timer = setTimeout(() => {
      res.end(JSON.stringify({ status: "ok" }));
    }, delayMs);
    res.once("close", () => clearTimeout(timer));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  listeners.push({ server, sockets });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function within<T>(promise: Promise<T>, ms = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation exceeded the test deadline")), ms);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockClear();
  for (const { server, sockets } of listeners.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const id of sessions.splice(0)) rmSync(join(tmpdir(), `lcm-restore-${id}.lock`), { force: true });
});

describe("daemon lifecycle deadlines", () => {
  it("connects to a busy daemon that answers after two seconds within a five-second budget", async () => {
    const port = await delayedHealthListener(2_000);
    const result = await within(ensureDaemon({ port, pidFilePath: pidPath(), spawnTimeoutMs: 5_000 }), 6_000);
    expect(result).toMatchObject({ connected: true, spawned: false });
    expect(result.unresponsive).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  }, 7_000);

  it.each([false, true])("does not report a busy listener stopped with a missing or dead PID (dead PID: %s)", async (deadPid) => {
    const port = await delayedHealthListener(2_000);
    const path = pidPath();
    if (deadPid) writeFileSync(path, "99999999");
    // The listener belongs to this test worker; signal attempts must never stop the suite.
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === process.pid) return true;
      throw new Error("ESRCH");
    });
    const startedAt = Date.now();
    const result = await within(stopDaemon({ port, pidFilePath: path, timeoutMs: 700 }));
    expect(result.stopped).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_200);
    expect(listeners.at(-1)!.server.listening).toBe(true);
  }, 2_000);

  it("waits for a busy daemon in a standalone health check with the default CLI deadline", async () => {
    const port = await delayedHealthListener(2_000);
    expect(await within(checkDaemonHealth(port), 6_000)).toEqual({ status: "ok" });
  }, 7_000);

  it("bounds a health probe against a real listener that never answers", async () => {
    const port = await silentListener();
    const startedAt = Date.now();
    expect(await within(checkDaemonHealth(port), 6_000)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  }, 7_000);

  it("includes a stalled response body in a shortened health deadline and cancels the fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_url, init) => {
      signal = init?.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    }) as unknown as typeof fetch;
    let result: unknown = "pending";
    void checkDaemonHealth(1, fetchFn, 75).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(74);
    expect(result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  }, 2_000);

  it("includes the initial probe in the spawn-wait budget", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error("offline")), 200);
      }))
      .mockImplementation(() => new Promise(() => {}));
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    let result: Awaited<ReturnType<typeof ensureDaemon>> | undefined;
    void ensureDaemon({ port: 1, pidFilePath: pidPath(), spawnTimeoutMs: 650,
      _fetchOverride: fetchFn, _spawnOverride: spawn as any }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(650);
    expect(result).toMatchObject({ connected: false, spawned: true });
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }, 2_000);

  it("includes the live-PID wait in the overall budget and does not spawn after expiry", async () => {
    vi.useFakeTimers();
    const path = pidPath();
    writeFileSync(path, String(process.pid));
    const fetchFn = vi.fn(async () => { throw new Error("offline"); });
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    let result: Awaited<ReturnType<typeof ensureDaemon>> | undefined;
    void ensureDaemon({ port: 1, pidFilePath: path, spawnTimeoutMs: 300,
      _fetchOverride: fetchFn, _spawnOverride: spawn as any }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(300);
    expect(result).toMatchObject({ connected: false, spawned: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(true);
  }, 2_000);

  it("caps the live-PID retry probe by the remaining budget", async () => {
    vi.useFakeTimers();
    const path = pidPath();
    writeFileSync(path, String(process.pid));
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise(() => {}));
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    let result: Awaited<ReturnType<typeof ensureDaemon>> | undefined;
    void ensureDaemon({ port: 1, pidFilePath: path, spawnTimeoutMs: 1_200,
      _fetchOverride: fetchFn, _spawnOverride: spawn as any }).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(1_199);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ connected: false, spawned: false, unresponsive: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  }, 2_000);

  it.each([false, true])("does not spawn over a silent listener (recorded PID: %s)", async (recorded) => {
    const port = await silentListener();
    const path = pidPath();
    if (recorded) writeFileSync(path, String(process.pid));
    const spawn = vi.fn(() => ({ unref: vi.fn() }));
    const startedAt = Date.now();
    const result = await within(ensureDaemon({ port, pidFilePath: path, spawnTimeoutMs: 5_000,
      _spawnOverride: spawn as any }), 6_000);
    expect(result).toMatchObject({ connected: false, spawned: false, unresponsive: true });
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(spawn).not.toHaveBeenCalled();
    if (recorded) expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  }, 7_000);

  it("keeps a connect-only probe short when a listener never answers", async () => {
    const port = await silentListener();
    const startedAt = Date.now();
    const result = await within(ensureDaemon({ port, pidFilePath: pidPath(), spawnTimeoutMs: 0, noSpawn: true }));
    expect(result).toMatchObject({ connected: false, spawned: false, unresponsive: true });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(spawnMock).not.toHaveBeenCalled();
  }, 2_000);

  it("fails open in restore within one health deadline against a silent socket", async () => {
    const port = await silentListener();
    const paths = createLcmPaths(dirname(pidPath()));
    const id = randomUUID();
    sessions.push(id);
    const client = { post: vi.fn() };
    const startedAt = Date.now();
    expect(await within(handleSessionStart(JSON.stringify({ session_id: id, cwd: paths.home }),
      client as any, paths, port), 6_000)).toEqual({ exitCode: 0, stdout: "" });
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(client.post).not.toHaveBeenCalled();
    expect(existsSync(paths.tokenPath)).toBe(false);
  }, 7_000);

  it("reports the stuck holder once per session through command-hook bootstrap", async () => {
    const port = await silentListener();
    const paths = createLcmPaths(lcmHome());
    writeFileSync(paths.configPath, JSON.stringify({ daemon: { port } }));
    writeFileSync(paths.pidPath, String(process.pid));
    const id = randomUUID();
    sessions.push(id);
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const input = JSON.stringify({ session_id: id, cwd: paths.home });
    expect(await within(dispatchHook("restore", input), 11_000)).toEqual({ exitCode: 0, stdout: "" });
    expect(await within(dispatchHook("restore", input), 6_000)).toEqual({ exitCode: 0, stdout: "" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/did not answer.*starting, busy or stuck/);
    expect(existsSync(paths.tokenPath)).toBe(false);
    expect(readFileSync(paths.pidPath, "utf8")).toBe(String(process.pid));
  }, 18_000);
});
