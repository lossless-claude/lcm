import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getMcpToolDefinitions, handleDaemonRequest } from "../../src/mcp/server.js";

const ensureDaemonMcpMock = vi.hoisted(() => vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: false }));

const holdMock = vi.hoisted(() => vi.fn().mockReturnValue(null));
const collectStatsMock = vi.hoisted(() => vi.fn(() => { throw new Error("database access during hold"); }));
vi.mock("../../src/daemon/hold.js", () => ({ readHold: holdMock }));
vi.mock("../../src/stats.js", () => ({ collectStats: collectStatsMock, formatNumber: String }));
afterEach(() => { holdMock.mockReturnValue(null); });

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: ensureDaemonMcpMock,
  registerDaemonActivity: vi.fn(() => vi.fn()),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ daemon: { port: 9999 } }),
}));
vi.mock("@modelcontextprotocol/server", () => ({
  Server: vi.fn().mockImplementation(function () { return { setRequestHandler: vi.fn() }; }),
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: vi.fn().mockReturnValue({ close: vi.fn() }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () { return { post: vi.fn() }; }),
}));
vi.mock("../../src/daemon/version.js", () => ({
  PKG_VERSION: "9.9.9-test",
}));

describe("MCP tool definitions", () => {
  it("exposes exactly 7 tools", () => {
    const tools = getMcpToolDefinitions();
    expect(tools).toHaveLength(7);
    expect(tools.map((t: any) => t.name).sort()).toEqual(["lcm_describe", "lcm_doctor", "lcm_expand", "lcm_grep", "lcm_search", "lcm_stats", "lcm_store"]);
  });

  it("each tool has name, description, inputSchema", () => {
    for (const tool of getMcpToolDefinitions()) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("lcm_grep description mentions conversation history", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_grep");
    expect(tool!.description).toContain("conversation history");
  });

  it("lcm_search description mentions episodic", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_search");
    expect(tool!.description).toContain("episodic");
  });

  it("advertises the native promoted layer without an external search backend", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_search")!;
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.layers.items.enum).toEqual(["episodic", "promoted"]);
    expect(properties.backend).toBeUndefined();
  });
});

describe("handleDaemonRequest", () => {
  const ensureDaemonMock = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: false });
  const opts = {
    port: 9999,
    pidFilePath: "/tmp/test-daemon.pid",
    _ensureDaemon: ensureDaemonMock,
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it("returns result on success", async () => {
    const client = { post: vi.fn().mockResolvedValue({ result: "ok" }) };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"result": "ok"');
  });

  it("does not retry on daemon HTTP errors (non-network)", async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error("HTTP 422")) };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(ensureDaemonMock).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
  });

  it("retries after network crash (TypeError) and returns result on successful retry", async () => {
    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "recovered" }),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(ensureDaemonMock).toHaveBeenCalled();
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"recovered"');
  });

  it("returns isError:true when both network attempts fail", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("daemon unavailable");
  });

  it("retry proceeds despite ensureDaemon throwing (non-fatal spawn failure)", async () => {
    ensureDaemonMock.mockRejectedValueOnce(new Error("spawn failed"));
    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };
    // ensureDaemon throws but retry still proceeds (non-fatal)
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBeUndefined(); // retry succeeded despite ensureDaemon throwing
    expect(res.content[0].text).toContain('"ok"');
  });
});

describe("startMcpServer", () => {
  it("passes PKG_VERSION as expectedVersion to ensureDaemon", async () => {
    const { startMcpServer } = await import("../../src/mcp/server.js");

    await startMcpServer();

    // PKG_VERSION is mocked to "9.9.9-test" via vi.mock("../../src/daemon/version.js")
    expect(ensureDaemonMcpMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "9.9.9-test" }),
    );
  });

  it("passes explicit spawnCommand and spawnArgs pointing to the CLI of this build", async () => {
    ensureDaemonMcpMock.mockClear();
    const { startMcpServer } = await import("../../src/mcp/server.js");

    await startMcpServer();

    expect(ensureDaemonMcpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnCommand: process.execPath,
        spawnArgs: expect.arrayContaining([
          expect.stringMatching(/[\/]lcm\.js$/),
          "daemon",
          "start",
        ]),
      }),
    );
  });
});

describe("handleDaemonRequest spawn opts propagation", () => {
  it("threads spawnCommand/spawnArgs/expectedVersion into ensureDaemon on auto-restart", async () => {
    const ensureDaemonSpy = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: true });
    const optsWithSpawn = {
      port: 9999,
      pidFilePath: "/tmp/test-daemon.pid",
      spawnCommand: "/usr/local/bin/node",
      spawnArgs: ["/path/to/lcm.js", "daemon", "start"],
      expectedVersion: "1.2.3",
      _ensureDaemon: ensureDaemonSpy,
    };

    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };

    await handleDaemonRequest(client, "/search", { q: "foo" }, optsWithSpawn);

    expect(ensureDaemonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnCommand: "/usr/local/bin/node",
        spawnArgs: ["/path/to/lcm.js", "daemon", "start"],
        expectedVersion: "1.2.3",
      }),
    );
  });

  it("passes undefined spawn opts when not provided (backwards compat)", async () => {
    const ensureDaemonSpy = vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: true });
    const optsMinimal = {
      port: 9999,
      pidFilePath: "/tmp/test-daemon.pid",
      _ensureDaemon: ensureDaemonSpy,
    };

    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce({ result: "ok" }),
    };

    await handleDaemonRequest(client, "/search", { q: "foo" }, optsMinimal);

    const callArgs = ensureDaemonSpy.mock.calls[0][0];
    expect(callArgs.spawnCommand).toBeUndefined();
    expect(callArgs.spawnArgs).toBeUndefined();
  });
});

it("blocks local database tools when a hold begins after MCP startup", async () => {
  const { Server } = await import("@modelcontextprotocol/server");
  const { startMcpServer } = await import("../../src/mcp/server.js");
  await startMcpServer();
  const server = vi.mocked(Server).mock.results.at(-1)!.value;
  const handler = server.setRequestHandler.mock.calls.find(([method]: [string]) => method === "tools/call")[1];
  holdMock.mockReturnValue({ until: "2099-01-01T00:00:00.000Z", pid: 1 });
  collectStatsMock.mockClear();
  const result = await handler({ params: { name: "lcm_stats", arguments: {} } });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("held down until");
  expect(collectStatsMock).not.toHaveBeenCalled();
});
