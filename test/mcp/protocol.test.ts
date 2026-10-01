import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { startMcpServer } from "../../src/mcp/server.js";
import { workerDisplayId } from "../../src/worker-warning.js";

const state = vi.hoisted(() => ({
  post: vi.fn(),
  transport: undefined as StdioServerTransport | undefined,
  handle: undefined as StdioServerHandle | undefined,
  stats: undefined as Record<string, unknown> | undefined,
  languages: { authorLanguage: "en", pivotLanguage: "en" } as { authorLanguage?: string; pivotLanguage: string },
}));

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
  registerDaemonActivity: vi.fn(() => vi.fn()),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: () => ({ daemon: { port: 9999 }, search: { pivotLanguage: "en" } }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(function () { return { post: state.post }; }),
}));
vi.mock("../../src/daemon/version.js", () => ({ PKG_VERSION: "9.9.9-test" }));
vi.mock("../../src/search/pivot-language.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/search/pivot-language.js")>(),
  pivotLanguagesFor: () => state.languages,
}));
vi.mock("../../src/stats.js", () => ({
  formatSubagentShare: String,
  collectStats: () => { if (state.stats) return state.stats; throw new Error("stats unavailable"); },
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
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
    vi.stubEnv("CODEX_THREAD_ID", "");
    input = new PassThrough();
    output = new PassThrough();
    lines = createInterface({ input: output });
    replies = lines[Symbol.asyncIterator]();
    state.transport = new StdioServerTransport(input, output);
    state.post.mockReset().mockResolvedValue({ matches: ["remembered"] });
    state.languages = { authorLanguage: "en", pivotLanguage: "en" };
    state.stats = undefined;
    id = 0;
    await startMcpServer();
  });

  afterEach(async () => {
    await state.handle?.close();
    vi.unstubAllEnvs();
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
      "lcm_describe", "lcm_doctor", "lcm_expand", "lcm_grep", "lcm_search", "lcm_stats", "lcm_store", "lcm_summarize_claim", "lcm_summarize_submit",
    ]);
  });

  it("refreshes the search description for each list request without changing its schema", async () => {
    state.languages = { authorLanguage: "pt-BR", pivotLanguage: "en" };
    const first = (await request("tools/list")).result.tools;
    const translated = first.find((tool: { name: string }) => tool.name === "lcm_search");
    expect(translated.description).toContain("author language is pt-BR");
    expect(translated.description).toContain("pass `pivotQuery`");

    state.languages = { authorLanguage: "en", pivotLanguage: "en" };
    const second = (await request("tools/list")).result.tools;
    const base = second.find((tool: { name: string }) => tool.name === "lcm_search");
    expect(base.description).not.toContain("author language is pt-BR");
    expect(base.inputSchema).toEqual(translated.inputSchema);
    expect(second.filter((tool: { name: string }) => tool.name !== "lcm_search"))
      .toEqual(first.filter((tool: { name: string }) => tool.name !== "lcm_search"));
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
    expect(state.post).toHaveBeenCalledWith(route, { ...args, ...(name === "lcm_store" ? { metadata: { sessionId: "manual" } } : {}), cwd: process.env.PWD ?? process.cwd() });
  });

  it.each([
    ["claude-session", "codex-thread", "claude-session"],
    ["", "codex-thread", "codex-thread"],
    ["", "", "manual"],
  ])("store forwards caller provenance (%s, %s)", async (claude, codex, sessionId) => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", claude);
    vi.stubEnv("CODEX_THREAD_ID", codex);
    await request("tools/call", { name: "lcm_store", arguments: { text: "insight" } });
    expect(state.post).toHaveBeenCalledWith("/store", {
      cwd: process.env.PWD ?? process.cwd(), text: "insight", metadata: { sessionId },
    });
  });

  it("store preserves explicit provenance and other metadata", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "harness-session");
    const metadata = { sessionId: "explicit-session", projectId: "explicit-project", depth: 2 };
    await request("tools/call", { name: "lcm_store", arguments: { text: "insight", metadata } });
    expect(state.post).toHaveBeenCalledWith("/store", {
      cwd: process.env.PWD ?? process.cwd(), text: "insight", metadata,
    });
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

  it.each([false, true])("lcm_stats uses the same short worker id as status and CLI diagnostics (verbose=%s)", async verbose => {
    const sessionId = "worker-session-unique-full-identity-685";
    state.stats = { workers: [{ session_id: sessionId, state: "active", last_activity: "2026-01-01 00:00:00" }],
      projects: 1, conversations: 0, messages: 0, summaries: 0, maxDepth: 0, promotedCount: 0,
      eventsCaptured: 0, redactionCounts: { total: 0 }, promotionCandidates: [], contested: [] };
    const { result } = await request("tools/call", { name: "lcm_stats", arguments: { verbose } });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).not.toContain(sessionId);
    expect(text).toContain(`Worker ${workerDisplayId(sessionId)}: active; last activity 2026-01-01 00:00:00`);
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

  it.each(["toString", "constructor", "__proto__"])("rejects inherited name %s as an unknown tool", async (name) => {
    const { result } = await request("tools/call", { name, arguments: {} });
    expect(result).toMatchObject({
      resultType: "complete", isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    });
    expect(state.post).not.toHaveBeenCalled();
  });

  // Both revisions are served, because which one a client offers is the client's choice
  // and not ours. Claude Code opens stdio servers on the 2025 revision unless the user
  // sets MCP_PROTOCOL_NEGOTIATION=auto, so serving only the modern one would answer
  // nothing at all under the default the documentation describes.
  it("serves a 2025-era client through initialization, listing and calling", async () => {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" },
    }, false);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toMatchObject({ protocolVersion: "2025-11-25" });

    const listed = await request("tools/list", {}, false);
    expect(listed.error).toBeUndefined();
    expect(listed.result.tools).toHaveLength(9);

    const called = await request("tools/call", { name: "lcm_search", arguments: { query: "hello" } }, false);
    expect(called.error).toBeUndefined();
    expect(called.result.content).toEqual([{ type: "text", text: JSON.stringify({ matches: ["remembered"] }, null, 2) }]);
  });

  it("serves a 2026-era client, and only that one carries the modern envelope", async () => {
    const listed = await request("tools/list");
    expect(listed.error).toBeUndefined();
    expect(listed.result.tools).toHaveLength(9);
    expect(listed.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    expect(listed.result._meta).toMatchObject({
      "io.modelcontextprotocol/serverInfo": { name: "lcm", version: "9.9.9-test" },
    });
  });
});
