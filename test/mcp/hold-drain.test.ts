import { expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeHold } from "../../src/daemon/hold.js";
import { stopDaemon } from "../../src/daemon/lifecycle.js";
import { startMcpServer } from "../../src/mcp/server.js";

const state = vi.hoisted(() => {
  let release!: () => void;
  return { root: "", accessed: false, handlers: new Map<string, any>(),
    gate: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
});
vi.mock("../../src/lcm-home.js", () => ({ lcmPath: (name: string) => `${state.root}/${name}` }));
vi.mock("../../src/daemon/config.js", () => ({ loadDaemonConfig: () => ({ daemon: { port: 1 } }) }));
vi.mock("../../src/daemon/lifecycle.js", async (original) => ({
  ...await original<typeof import("../../src/daemon/lifecycle.js")>(),
  ensureDaemon: vi.fn().mockResolvedValue({ connected: false }),
}));
vi.mock("@modelcontextprotocol/server", () => ({
  Server: class { setRequestHandler(name: string, handler: any) { state.handlers.set(name, handler); } },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: vi.fn() }));
vi.mock("../../src/stats.js", async () => {
  await state.gate;
  return { formatNumber: String, collectStats: () => {
    state.accessed = true;
    throw new Error("simulated database failure");
  } };
});

it("held stop waits for an admitted local MCP operation, including its error cleanup", async () => {
  state.root = mkdtempSync(join(tmpdir(), "lcm-mcp-drain-"));
  const pidFilePath = join(state.root, "daemon.pid");
  let request: Promise<any> | undefined;
  let stopping: Promise<any> | undefined;
  try {
    await startMcpServer();
    request = state.handlers.get("tools/call")({ params: { name: "lcm_stats", arguments: {} } });
    expect(readdirSync(state.root).some((name) => name.startsWith("daemon.starting."))).toBe(true);
    writeHold(pidFilePath);
    let stopped = false;
    stopping = stopDaemon({ port: 1, pidFilePath, timeoutMs: 1000,
      _fetchOverride: vi.fn().mockRejectedValue(new TypeError("offline")) }).then((result) => {
      stopped = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false);
    expect(state.accessed).toBe(false);
    state.release();
    expect((await request).isError).toBe(true);
    expect(state.accessed).toBe(true);
    await expect(stopping).resolves.toMatchObject({ stopped: true });
    expect(readdirSync(state.root).some((name) => name.startsWith("daemon.starting."))).toBe(false);
  } finally {
    state.release();
    await Promise.allSettled([request, stopping]);
    rmSync(state.root, { recursive: true, force: true });
  }
});
