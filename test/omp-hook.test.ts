import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setTransportForTests,
  type HookApi,
  type HookContext,
  type HookHandler,
  type TransportRequest,
  normalizeOmpTool,
} from "../hooks/omp/lcm.js";
import lcm from "../hooks/omp/lcm.js";

function context(overrides: Partial<HookContext> = {}): HookContext {
  return {
    cwd: "/workspace/omp-project",
    sessionManager: {
      getSessionId: () => "omp-session",
      getSessionFile: () => "/workspace/omp-session.jsonl",
    },
    ...overrides,
  };
}

function hook(): { handlers: Map<string, HookHandler>; pi: HookApi } {
  const handlers = new Map<string, HookHandler>();
  const pi: HookApi = {
    on: (event, handler) => handlers.set(event, handler),
    logger: { error: vi.fn() },
  };
  lcm(pi);
  return { handlers, pi };
}

function getHandler(handlers: Map<string, HookHandler>, event: string): HookHandler {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`missing handler ${event}`);
  return handler;
}

describe("OMP lcm hook", () => {
  let requests: TransportRequest[];

  beforeEach(() => {
    requests = [];
    process.env.LCM_HOME = "omp-hook-test-home";
    __setTransportForTests((request) => {
      requests.push(request);
      if (request.path === "/restore") return { context: "restored memory" };
      return undefined;
    });
  });

  afterEach(() => {
    __setTransportForTests();
    delete process.env.LCM_HOME;
  });

  it("captures, restores, and schedules startup compaction with the omp client", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_start")({ type: "session_start" }, context());

    expect(requests.map((request) => request.path)).toEqual([
      "/ingest",
      "/restore",
      "/session-start-compact",
    ]);
    expect(requests[0]?.body).toMatchObject({
      session_id: "omp-session",
      cwd: "/workspace/omp-project",
      client: "omp",
      source: "live",
      transcript_path: "/workspace/omp-session.jsonl",
    });
    expect(requests[1]?.body).toMatchObject({
      session_id: "omp-session",
      cwd: "/workspace/omp-project",
      client: "omp",
      source: "startup",
    });
    expect(requests[2]?.body).toEqual({
      session_id: "omp-session",
      cwd: "/workspace/omp-project",
      client: "omp",
    });
    expect(requests[0]?.fireAndForget).toBe(true);
    expect(requests[1]?.fireAndForget).toBe(false);
  });

  it("injects restore exactly once and combines prompt-search context in one message", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_start")({}, context());
    const before = getHandler(handlers, "before_agent_start");
    const first = await before({ prompt: "first prompt" }, context()) as {
      message: Record<string, unknown>;
    };
    expect(first.message).toMatchObject({
      customType: "lcm-memory",
      content: "restored memory",
      display: true,
      attribution: "agent",
    });

    const second = await before({ prompt: "second prompt" }, context());
    expect(second).toBeUndefined();
    expect(requests.filter((request) => request.path === "/prompt-search")).toHaveLength(2);
  });

  it("injects prompt-search context and returns undefined for an empty context", async () => {
    const { handlers } = hook();
    requests = [];
    __setTransportForTests((request) => {
      requests.push(request);
      return request.path === "/prompt-search" ? { context: "search memory" } : undefined;
    });
    const result = await getHandler(handlers, "before_agent_start")({ prompt: "find this" }, context()) as {
      message: Record<string, unknown>;
    };
    expect(result.message).toMatchObject({ content: "search memory", customType: "lcm-memory" });

    __setTransportForTests((request) => {
      requests.push(request);
      return request.path === "/prompt-search" ? { context: "  " } : undefined;
    });
    expect(await getHandler(hook().handlers, "before_agent_start")({ prompt: "no hint" }, context())).toBeUndefined();
  });

  it("ingests only when agent_end will not continue", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "agent_end")({ willContinue: true }, context());
    expect(requests).toHaveLength(0);
    await getHandler(handlers, "agent_end")({ willContinue: false }, context());
    expect(requests.map((request) => request.path)).toEqual(["/ingest"]);
  });

  it("posts tool events with success and failure hook names", async () => {
    const { handlers } = hook();
    const tool = getHandler(handlers, "tool_result");
    await tool({ toolName: "Bash", toolCallId: "call-1", input: { command: "false" }, content: "failed", isError: true }, context({ model: { id: "model-id" } }));
    await tool({ toolName: "Read", toolCallId: "call-2", input: { file_path: "a.ts" }, content: "ok", isError: false }, context({ model: { name: "model-name" } }));

    expect(requests.map((request) => request.path)).toEqual(["/tool-event", "/tool-event"]);
    expect(requests[0]?.body).toMatchObject({
      client: "omp",
      tool_name: "Bash",
      tool_use_id: "call-1",
      model: "model-id",
      hook_event_name: "PostToolUseFailure",
      tool_output: { isError: true },
    });
    expect(requests[1]?.body).toMatchObject({
      model: "model-name",
      hook_event_name: "PostToolUse",
    });
    expect(requests[1]?.body).not.toHaveProperty("tool_output");
  });

  it("ingests and compacts before a session compact", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_before_compact")({}, context());
    expect(requests.map((request) => request.path)).toEqual(["/ingest", "/compact"]);
    expect(requests[1]?.body).toMatchObject({
      session_id: "omp-session",
      cwd: "/workspace/omp-project",
      client: "omp",
      skip_ingest: true,
    });
  });

  it("fails open when the transport throws for every handler", async () => {
    __setTransportForTests(() => {
      throw new Error("daemon unavailable");
    });
    const { handlers } = hook();
    const ctx = context();
    await expect(getHandler(handlers, "session_start")({}, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "before_agent_start")({ prompt: "hello" }, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "agent_end")({}, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "session_stop")({ session_id: "omp-session" }, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "tool_result")({ toolName: "Read", input: {}, content: "x" }, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "session_before_compact")({}, ctx)).resolves.toBeUndefined();
    await expect(getHandler(handlers, "session_shutdown")({}, ctx)).resolves.toBeUndefined();
  });

  it("skips daemon calls when session identity is incomplete", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_start")({}, context({ cwd: undefined }));
    await getHandler(handlers, "tool_result")({ toolName: "Read", content: "x" }, context({
      sessionManager: { getSessionId: () => undefined },
    }));
    expect(requests).toHaveLength(0);
  });

  it("translates OMP's lowercase tool ids into the names the extractor keys on", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "tool_result")({ toolName: "read", toolCallId: "c1", input: { path: "src/a.ts" }, content: "ok" }, context());

    expect(requests[0]?.body).toMatchObject({ tool_name: "Read", client: "omp" });
    expect(requests[0]?.body.tool_input).toEqual({ path: "src/a.ts" });
  });
});

describe("normalizeOmpTool", () => {
  it("maps the file tools and carries a structural edit's path set for the extractor", () => {
    expect(normalizeOmpTool("write", { path: "b.md" }, undefined)).toEqual({ tool_name: "Write", tool_input: { path: "b.md" } });
    expect(normalizeOmpTool("ast_edit", { pat: "x", paths: ["a.ts", "b.ts"] }, undefined)).toEqual({
      tool_name: "Edit",
      tool_input: { pat: "x", paths: ["a.ts", "b.ts"], file_paths: ["a.ts", "b.ts"] },
    });
    expect(normalizeOmpTool("ast_grep", { pat: "x", paths: ["a.ts"] }, undefined)).toEqual({
      tool_name: "Grep",
      tool_input: { pat: "x", paths: ["a.ts"], file_paths: ["a.ts"] },
    });
  });

  it("gives a subagent dispatch the description the extractor reads", () => {
    expect(normalizeOmpTool("task", { label: "Explore auth", prompt: "go" }, undefined)).toEqual({
      tool_name: "Agent",
      tool_input: { label: "Explore auth", prompt: "go", description: "Explore auth" },
    });
    expect(normalizeOmpTool("task", { prompt: "first line\nsecond" }, undefined).tool_input.description).toBe("first line");
  });

  it("turns an ask into a decision with its question and answer", () => {
    expect(normalizeOmpTool("ask", { questions: [{ header: "Auth", question: "Which flow?" }] }, "OAuth2")).toEqual({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ header: "Auth", question: "Which flow?" }], question: "Auth: Which flow?" },
      tool_response: "OAuth2",
    });
  });

  it("names the skill behind a manage_skill call", () => {
    expect(normalizeOmpTool("manage_skill", { action: "create", name: "lcm-memory" }, undefined)).toEqual({
      tool_name: "Skill",
      tool_input: { action: "create", name: "lcm-memory", skill: "lcm-memory" },
    });
  });

  it("leaves names the extractor has no case for, and MCP tools, untouched", () => {
    expect(normalizeOmpTool("lsp", { query: "x" }, undefined)).toEqual({ tool_name: "lsp", tool_input: { query: "x" } });
    expect(normalizeOmpTool("mcp__github__search", {}, undefined).tool_name).toBe("mcp__github__search");
  });
});
