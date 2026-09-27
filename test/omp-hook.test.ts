import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setTransportForTests,
  type HookApi,
  type HookContext,
  type HookHandler,
  type TransportRequest,
  translateOmpTool,
} from "../hooks/omp/lcm.js";
import { extractPostToolEvents } from "../src/hooks/extractors.js";
import lcm from "../hooks/omp/lcm.js";
import { readOmpHookSnapshots } from "../src/doctor/hook-snapshots.js";

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

function hook(): { handlers: Map<string, HookHandler>; pi: HookApi; loggerError: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, HookHandler>();
  const loggerError = vi.fn();
  const pi: HookApi = {
    on: (event, handler) => handlers.set(event, handler),
    logger: { error: loggerError },
  };
  lcm(pi);
  return { handlers, pi, loggerError };
}

function getHandler(handlers: Map<string, HookHandler>, event: string): HookHandler {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`missing handler ${event}`);
  return handler;
}

describe("OMP lcm hook", () => {
  let requests: TransportRequest[];
  let home: string;

  beforeEach(() => {
    requests = [];
    home = mkdtempSync(join(tmpdir(), "omp-hook-test-home-"));
    process.env.LCM_HOME = home;
    __setTransportForTests((request) => {
      requests.push(request);
      if (request.path === "/restore") return { context: "restored memory" };
      if (request.path === "/ingest") return { ingested: 0 };
      return undefined;
    });
  });

  afterEach(() => {
    __setTransportForTests();
    delete process.env.LCM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("waits for the capture before restoring, so restore cannot read a session that is still landing", async () => {
    const order: string[] = [];
    const ingest = Promise.withResolvers<void>();
    __setTransportForTests(async (request) => {
      if (request.path === "/restore") {
        order.push("restore");
        return { context: "restored memory" };
      }
      if (request.path !== "/ingest") return undefined;
      order.push("ingest:start");
      await ingest.promise;
      order.push("ingest:end");
      return undefined;
    });

    const { handlers } = hook();
    const started = getHandler(handlers, "session_start")({ type: "session_start" }, context());
    // Let the handler reach the ingest request, then hold it until released: a restore
    // issued before this point would be recorded ahead of "ingest:end".
    await Promise.resolve();
    await Promise.resolve();
    order.push("released");
    ingest.resolve();
    await started;

    expect(order).toEqual(["ingest:start", "released", "ingest:end", "restore"]);
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
    // Only the sweep is fire-and-forget: capture and restore are awaited so restore
    // reads a captured session (the ordering test above), and the compaction sweep
    // must not delay session start.
    expect(requests[1]?.fireAndForget).toBe(false);
    expect(requests[2]?.fireAndForget).toBe(true);
  });

  it("skips capture while OMP has not written the session file yet, and still restores", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_start")({ type: "session_start" }, context({
      sessionManager: {
        getSessionId: () => "omp-session",
        getSessionFile: () => "/workspace/omp-session.jsonl",
        isSessionOnDisk: () => false,
      },
    }));

    // No /ingest: a path OMP has allocated but not written is refused by the daemon.
    expect(requests.map((request) => request.path)).toEqual(["/restore", "/session-start-compact"]);

    await getHandler(handlers, "agent_end")({}, context({
      sessionManager: {
        getSessionId: () => "omp-session",
        getSessionFile: () => "/workspace/omp-session.jsonl",
        isSessionOnDisk: () => false,
      },
    }));
    expect(requests.map((request) => request.path)).toEqual(["/restore", "/session-start-compact"]);
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
    const privatePayload = "PRIVATE_TOOL_PAYLOAD_97a";
    await tool({ toolName: "Bash", toolCallId: "call-1", input: { command: privatePayload }, content: privatePayload, isError: true }, context({ model: { id: "model-id" } }));
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
    const snapshot = readdirSync(join(home, "logs")).find((name) => name.startsWith("lcm-hook-observe-omp-"));
    expect(snapshot).toBeDefined();
    expect(readFileSync(join(home, "logs", snapshot!), "utf8")).not.toContain(privatePayload);
    expect(requests[1]?.body).not.toHaveProperty("tool_output");
  });

  it("throttles failed observation snapshot attempts across tool events", async () => {
    // A file at logs/ makes snapshot mkdir fail without affecting the hook result.
    writeFileSync(join(home, "logs"), "unwritable snapshot destination");
    const { handlers, loggerError } = hook();
    const tool = getHandler(handlers, "tool_result");
    for (let index = 0; index < 20; index++) {
      await expect(tool({ toolName: "Read", input: { path: "a.ts" }, content: "ok" }, context()))
        .resolves.toBeUndefined();
    }
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("sends lcm summarization only after confirmed pre-compaction capture", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "session_before_compact")({}, context());
    expect(requests.map((request) => request.path)).toEqual(["/ingest", "/compact"]);
    expect(requests[1]?.body).toMatchObject({
      session_id: "omp-session",
      cwd: "/workspace/omp-project",
      client: "omp",
      skip_ingest: true,
      precompact_verified: true,
    });
    expect(readOmpHookSnapshots("/workspace/omp-project", join(home, "logs"))).toMatchObject([
      { observations: expect.arrayContaining([
        expect.objectContaining({ hook: "session_before_compact", operation: "capture", kind: "delivery", status: "accepted" }),
        expect.objectContaining({ hook: "session_before_compact", operation: "summary", kind: "delivery", status: "submitted" }),
      ]) },
    ]);
  });

  it("skips lcm summarization when pre-compaction capture is unconfirmed", async () => {
    __setTransportForTests((request) => {
      requests.push(request);
      return undefined;
    });
    const { handlers } = hook();
    await getHandler(handlers, "session_before_compact")({}, context());
    expect(requests.map((request) => request.path)).toEqual(["/ingest"]);
    expect(readOmpHookSnapshots("/workspace/omp-project", join(home, "logs"))[0].observations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "summary", status: "skipped", reason: "capture-unconfirmed" }),
      ]));
  });

  it("records an HTTP capture rejection separately from unknown delivery", async () => {
    __setTransportForTests((request) => {
      requests.push(request);
      return Promise.reject(Object.assign(new Error("rejected"), { status: 401 }));
    });
    const { handlers } = hook();
    await getHandler(handlers, "session_before_compact")({}, context());
    expect(requests.map((request) => request.path)).toEqual(["/ingest"]);
    expect(readOmpHookSnapshots("/workspace/omp-project", join(home, "logs"))[0].observations)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "capture", kind: "delivery", status: "rejected", reason: "http-401" }),
        expect.objectContaining({ operation: "summary", status: "skipped", reason: "capture-rejected" }),
      ]));
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
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  it("translates OMP's lowercase tool ids into the names the extractor keys on", async () => {
    const { handlers } = hook();
    await getHandler(handlers, "tool_result")({ toolName: "read", toolCallId: "c1", input: { path: "src/a.ts" }, content: "ok" }, context());

    expect(requests[0]?.body).toMatchObject({ tool_name: "Read", client: "omp" });
    expect(requests[0]?.body.tool_input).toEqual({ path: "src/a.ts" });
  });
});

describe("translateOmpTool", () => {
  it("maps the file tools and carries a structural edit's path set for the extractor", () => {
    expect(translateOmpTool({ toolName: "write", input: { path: "b.md" } })).toEqual({ tool_name: "Write", tool_input: { path: "b.md" } });
    expect(translateOmpTool({ toolName: "ast_edit", input: { pat: "x", paths: ["a.ts", "b.ts"] } })).toEqual({
      tool_name: "Edit",
      tool_input: { pat: "x", paths: ["a.ts", "b.ts"], file_paths: ["a.ts", "b.ts"] },
    });
    expect(translateOmpTool({ toolName: "ast_grep", input: { pat: "x", paths: ["a.ts"] } })).toEqual({
      tool_name: "Grep",
      tool_input: { pat: "x", paths: ["a.ts"], file_paths: ["a.ts"] },
    });
  });

  it("gives a subagent dispatch the description the extractor reads", () => {
    expect(translateOmpTool({ toolName: "task", input: { label: "Explore auth", prompt: "go" } })).toEqual({
      tool_name: "Agent",
      tool_input: { label: "Explore auth", prompt: "go", description: "Explore auth" },
    });
    expect(translateOmpTool({ toolName: "task", input: { prompt: "first line\nsecond" } }).tool_input.description).toBe("first line");
    // A dispatch that names nothing travels under its own name rather than inventing one.
    expect(translateOmpTool({ toolName: "task", input: {} }).tool_name).toBe("task");
  });

  it("turns an ask into a decision question", () => {
    expect(translateOmpTool({ toolName: "ask", input: { questions: [{ header: "Auth", question: "Which flow?" }] } })).toEqual({
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ header: "Auth", question: "Which flow?" }], question: "Auth: Which flow?" },
    });
  });

  it("names the skill behind a manage_skill call", () => {
    expect(translateOmpTool({ toolName: "manage_skill", input: { action: "create", name: "lcm-memory" } })).toEqual({
      tool_name: "Skill",
      tool_input: { action: "create", name: "lcm-memory", skill: "lcm-memory" },
    });
  });

  it("turns a todo operation into a task update, and leaves a read alone", () => {
    expect(translateOmpTool({ toolName: "todo", input: { op: "start", task: "Inspect repo" } })).toEqual({
      tool_name: "TaskUpdate",
      tool_input: { op: "start", task: "Inspect repo", subject: "Inspect repo", status: "in_progress" },
    });
    // An init names its work as a phased list rather than a single task.
    expect(translateOmpTool({ toolName: "todo", input: { op: "init", list: [{ phase: "Requested", items: ["Inspect repo", "Write summary"] }] } }).tool_input)
      .toMatchObject({ subject: "Inspect repo", status: "created" });
    expect(translateOmpTool({ toolName: "todo", input: { op: "done", task: "Inspect repo" } }).tool_input.status).toBe("completed");
    // Blocking and unblocking are the states OMP itself records.
    expect(translateOmpTool({ toolName: "todo", input: { op: "block", task: "Inspect repo", reason: "waiting on CI" } }).tool_input.status).toBe("blocked");
    expect(translateOmpTool({ toolName: "todo", input: { op: "unblock", task: "Inspect repo" } }).tool_input.status).toBe("pending");
    // `view` reads the list: no act to record, so the call travels under its own name.
    expect(translateOmpTool({ toolName: "todo", input: { op: "view" } }).tool_name).toBe("todo");
  });

  it("maps the tools the extractor gained for this harness", () => {
    expect(translateOmpTool({ toolName: "github", input: { op: "pr_create", title: "Fix the parser" } })).toEqual({
      tool_name: "GitHub",
      tool_input: { op: "pr_create", title: "Fix the parser", detail: "Fix the parser" },
    });
    expect(translateOmpTool({ toolName: "github", input: { op: "search_prs", query: "x" } }).tool_name).toBe("github");
    expect(translateOmpTool({ toolName: "security_scan", input: { action: "start", target_kind: "working_tree" } })).toEqual({
      tool_name: "SecurityScan",
      tool_input: { action: "start", target_kind: "working_tree" },
    });
    expect(translateOmpTool({ toolName: "context_notes", input: { text: "Postgres for the ledger" } })).toEqual({
      tool_name: "ContextNote",
      tool_input: { text: "Postgres for the ledger" },
    });
    expect(translateOmpTool({ toolName: "checkpoint", input: { goal: "explore the parser" } })).toEqual({
      tool_name: "ContextChange",
      tool_input: { goal: "explore the parser", kind: "checkpoint", detail: "explore the parser" },
    });
    expect(translateOmpTool({ toolName: "rewind", input: { report: "abandoned the SQLite path\nmore detail" } }).tool_input)
      .toEqual({ report: "abandoned the SQLite path\nmore detail", kind: "rewind", detail: "abandoned the SQLite path" });
    expect(translateOmpTool({ toolName: "new_context", input: {} })).toEqual({ tool_name: "ContextChange", tool_input: { kind: "reset" } });
  });

  it("leaves the harness's own memory tools and its queries under their own names", () => {
    for (const toolName of ["retain", "recall", "reflect", "learn", "memory_edit", "lsp", "eval", "hub", "web_search"]) {
      expect(translateOmpTool({ toolName, input: { query: "x" } }).tool_name, toolName).toBe(toolName);
    }
    expect(translateOmpTool({ toolName: "mcp__github__search", input: {} }).tool_name).toBe("mcp__github__search");
  });
});

/**
 * The table above is inlined in the hook, which cannot import lcm's seam. This is what
 * holds the two together: every mapped payload must reach the real extractor and produce
 * a real event, so a mapping that drifts from the extractor's expectations fails here.
 */
describe("OMP tool vocabulary against the real extractor", () => {
  const cases: Array<{ toolName: string; input: Record<string, unknown>; response?: string; type: string }> = [
    { toolName: "read", input: { path: "src/a.ts" }, type: "file_read" },
    { toolName: "write", input: { path: "src/a.ts" }, type: "file_write" },
    { toolName: "edit", input: { path: "src/a.ts" }, type: "file_edit" },
    { toolName: "glob", input: { pattern: "src/**" }, type: "file_glob" },
    { toolName: "grep", input: { pattern: "needle" }, type: "file_grep" },
    { toolName: "bash", input: { command: "git commit -m x" }, type: "git_commit" },
    { toolName: "ast_edit", input: { pat: "x", paths: ["src/a.ts"] }, type: "file_edit" },
    { toolName: "ast_grep", input: { pat: "x", paths: ["src/a.ts"] }, type: "file_grep" },
    { toolName: "task", input: { label: "Explore auth" }, type: "subagent_dispatch" },
    { toolName: "ask", input: { questions: [{ header: "Auth", question: "Which flow?" }] }, response: "OAuth2", type: "decision" },
    { toolName: "manage_skill", input: { action: "create", name: "lcm-memory" }, type: "skill_use" },
    { toolName: "todo", input: { op: "start", task: "Inspect repo" }, type: "task_update" },
    { toolName: "github", input: { op: "pr_create", title: "Fix the parser" }, type: "github_pr_create" },
    { toolName: "security_scan", input: { action: "start", target_kind: "working_tree" }, type: "security_scan" },
    { toolName: "context_notes", input: { text: "Postgres for the ledger" }, type: "context_note" },
    { toolName: "checkpoint", input: { goal: "explore the parser" }, type: "context_checkpoint" },
    { toolName: "rewind", input: { report: "abandoned the SQLite path" }, type: "context_rewind" },
    { toolName: "new_context", input: {}, type: "context_reset" },
  ];

  it.each(cases)("$toolName reaches the extractor as $type", ({ toolName, input, response, type }) => {
    const translated = translateOmpTool({ toolName, input });
    const events = extractPostToolEvents({
      tool_name: translated.tool_name,
      tool_input: translated.tool_input,
      ...(response === undefined ? {} : { tool_response: response }),
      hook_event_name: "PostToolUse",
    });
    expect(events.map((event) => event.type)).toContain(type);
  });

  it("records a failure for a silent tool, which is how its calls still reach the extractor", () => {
    const translated = translateOmpTool({ toolName: "retain", input: { items: [] } });
    const events = extractPostToolEvents({
      tool_name: translated.tool_name,
      tool_input: translated.tool_input,
      hook_event_name: "PostToolUseFailure",
      error: "memory backend unavailable",
    });
    expect(events.map((event) => event.type)).toEqual(["error_tool"]);
  });
});
