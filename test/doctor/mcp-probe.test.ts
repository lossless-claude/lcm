import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testMcpHandshake } from "../../src/doctor/doctor.js";

function probe() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
  const result = testMcpHandshake(vi.fn(() => child) as unknown as typeof spawn);
  return { child, result };
}

afterEach(() => vi.useRealTimers());

describe("doctor MCP probe", () => {
  it("lists tools directly with modern metadata and waits for a complete response", async () => {
    const { child, result } = probe();
    expect(JSON.parse(child.stdin.read().toString())).toMatchObject({
      id: 1, method: "tools/list", params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    });
    expect(child.stdin.writableEnded).toBe(false);
    child.stdout.write('not-json\n{"jsonrpc":"2.0","method":"notifications/progress"}\n');
    const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", tools: Array(7).fill({}) } });
    child.stdout.write(response.slice(0, 30));
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.write(response.slice(30) + "\n");
    expect(await result).toMatchObject({ status: "pass", message: "lcm: 7/7 tools" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("warns for a protocol error instead of reporting healthy tools", async () => {
    const { child, result } = probe();
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32022 } }) + "\n");
    expect(await result).toMatchObject({ status: "warn", message: "lcm: 0/7 tools" });
  });

  it("handles EPIPE when the child exits before accepting the request", async () => {
    const { child, result } = probe();
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.emit("close", 1);
    expect(await result).toMatchObject({ status: "warn", message: "Could not write to MCP process" });
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("settles on process exit or spawn failure", async () => {
    const closed = probe();
    closed.child.emit("close", 1);
    expect(await closed.result).toMatchObject({ status: "warn" });
    const failed = probe();
    failed.child.emit("error", new Error("spawn failed"));
    expect(await failed.result).toMatchObject({ status: "warn", message: "Could not spawn MCP process" });
  });

  it("bounds the wait for an unresponsive server", async () => {
    vi.useFakeTimers();
    const { child, result } = probe();
    await vi.advanceTimersByTimeAsync(6000);
    expect(await result).toMatchObject({ status: "warn" });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
