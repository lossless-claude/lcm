import { describe, it, expect, vi } from "vitest";
import { getMcpToolDefinitions, handleDaemonRequest } from "../../src/mcp/server.js";

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
});

describe("handleDaemonRequest", () => {
  const opts = {
    port: 9999,
    pidFilePath: "/tmp/test-daemon.pid",
    _ensureDaemon: vi.fn().mockResolvedValue({ connected: true, port: 9999, spawned: false }),
  };

  it("returns result on success", async () => {
    const client = { post: vi.fn().mockResolvedValue({ result: "ok" }) };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"result": "ok"');
  });

  it("retries after daemon crash and returns result on successful retry", async () => {
    const client = {
      post: vi.fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ result: "recovered" }),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(opts._ensureDaemon).toHaveBeenCalled();
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"recovered"');
  });

  it("returns isError:true when both attempts fail", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new Error("daemon is gone")),
    };
    const res = await handleDaemonRequest(client, "/search", { q: "foo" }, opts);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("daemon unavailable");
    expect(res.content[0].text).toContain("daemon is gone");
  });
});
