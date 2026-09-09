import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { startMcpServer } from "../../src/mcp/server.js";

const state = vi.hoisted(() => ({
  post: vi.fn(),
  transport: undefined as StdioServerTransport | undefined,
  handle: undefined as StdioServerHandle | undefined,
}));

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: () => ({ daemon: { port: 9999 } }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () { return { post: state.post }; }),
}));
vi.mock("../../src/daemon/version.js", () => ({ PKG_VERSION: "9.9.9-test" }));
vi.mock("../../src/stats.js", () => ({
  collectStats: () => { throw new Error("stats unavailable"); },
  formatNumber: String,
}));
vi.mock("../../src/doctor/doctor.js", () => ({
  runDoctor: async () => [],
  formatResultsPlain: () => "doctor ok",
}));
vi.mock("@modelcontextprotocol/server/stdio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/server/stdio")>();
  return {
    ...actual,
    serveStdio: (factory: Parameters<typeof actual.serveStdio>[0], options: Parameters<typeof actual.serveStdio>[1]) => {
      state.handle = actual.serveStdio(factory, { ...options, transport: state.transport });
      return state.handle;
    },
  };
});

describe("MCP 2026-07-28 over stdio", () => {
  let input: PassThrough;
  let output: PassThrough;
  let lines: ReturnType<typeof createInterface>;
  let replies: AsyncIterableIterator<string>;
  let id: number;

  beforeEach(async () => {
    input = new PassThrough();
    output = new PassThrough();
    lines = createInterface({ input: output });
    replies = lines[Symbol.asyncIterator]();
    state.transport = new StdioServerTransport(input, output);
    state.post.mockReset().mockResolvedValue({ matches: ["remembered"] });
    id = 0;
    await startMcpServer();
  });

  afterEach(async () => {
    await state.handle?.close();
    lines.close();
    input.destroy();
    output.destroy();
  });

  async function request(method: string, params: Record<string, unknown> = {}, modern = true) {
    const requestId = ++id;
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: requestId, method,
      params: modern ? {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "lcm-test", version: "1.0.0" },
        },
      } : params,
    }) + "\n");
    const reply = JSON.parse((await replies.next()).value!);
    expect(reply.id).toBe(requestId);
    return reply;
  }

  it("discovers and lists seven tools without an initialize handshake", async () => {
    const discovery = await request("server/discover");
    expect(discovery.error).toBeUndefined();
    expect(discovery.result).toMatchObject({ resultType: "complete" });
    const { result, error } = await request("tools/list");
    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      resultType: "complete", ttlMs: 0, cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "lcm", version: "9.9.9-test" } },
    });
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      "lcm_describe", "lcm_doctor", "lcm_expand", "lcm_grep", "lcm_search", "lcm_stats", "lcm_store",
    ]);
  });

  it.each([
    ["lcm_grep", "/grep", { query: "hello" }],
    ["lcm_search", "/search", { query: "hello" }],
    ["lcm_describe", "/describe", { nodeId: "sum_1" }],
    ["lcm_expand", "/expand", { nodeId: "sum_1" }],
    ["lcm_store", "/store", { text: "hello" }],
  ])("calls %s directly and preserves the argument allowlist", async (name, route, args) => {
    const { result, error } = await request("tools/call", {
      name, arguments: { ...args, cwd: "/injected", unexpected: true },
    });
    expect(error).toBeUndefined();
    expect(result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: JSON.stringify({ matches: ["remembered"] }, null, 2) }] });
    expect(state.post).toHaveBeenCalledWith(route, { ...args, cwd: process.env.PWD ?? process.cwd() });
  });

  it("preserves local tool results and errors", async () => {
    expect((await request("tools/call", { name: "lcm_doctor" })).result).toMatchObject({
      resultType: "complete", content: [{ type: "text", text: "doctor ok" }],
    });
    expect((await request("tools/call", { name: "lcm_stats" })).result).toMatchObject({
      resultType: "complete", isError: true, content: [{ type: "text", text: "lcm error: stats unavailable" }],
    });
    expect(state.post).not.toHaveBeenCalled();
  });

  it("preserves daemon and unknown-tool errors", async () => {
    state.post.mockRejectedValueOnce(new Error("HTTP 422"));
    expect((await request("tools/call", { name: "lcm_search", arguments: { query: "hello" } })).result).toMatchObject({
      resultType: "complete", isError: true, content: [{ type: "text", text: "lcm error: HTTP 422" }],
    });
    expect((await request("tools/call", { name: "not_a_tool" })).result).toMatchObject({
      resultType: "complete", isError: true, content: [{ type: "text", text: "Unknown tool: not_a_tool" }],
    });
  });

  it("rejects legacy initialization while allowing a subsequent modern request", async () => {
    const legacy = await request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" },
    }, false);
    expect(legacy.error).toMatchObject({ code: -32022 });
    expect((await request("tools/list")).result.tools).toHaveLength(7);
  });

  it("rejects requests without per-request protocol metadata", async () => {
    expect((await request("tools/list", {}, false)).error).toMatchObject({ code: -32022 });
    expect(state.post).not.toHaveBeenCalled();
  });
});
