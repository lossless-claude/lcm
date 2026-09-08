import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const enabled = process.env.LCM_CODEX_NATIVE_RUNTIME === "1";
const codex = process.env.LCM_CODEX_NATIVE_BIN ?? "codex";

type HookRecord = {
  payload: Record<string, unknown>;
  transcript: { lineCount: number; roles: string[]; texts: string[] } | null;
};

type ResponseRequest = { input?: Array<{ content?: Array<{ text?: string }> }> };

let tmpRoot: string | undefined;
let server: Server | undefined;

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function hookScript(logPath: string): string {
  return `
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync(0, "utf8"));
let transcript = null;
if (payload.transcript_path && existsSync(payload.transcript_path)) {
  const rows = readFileSync(payload.transcript_path, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
  const messages = rows
    .filter((row) => row.type === "response_item" && row.payload?.type === "message")
    .map((row) => row.payload);
  transcript = {
    lineCount: rows.length,
    roles: messages.map((message) => message.role),
    texts: messages.flatMap((message) => message.content ?? []).map((part) => part?.text).filter((text) => typeof text === "string"),
  };
}

appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ payload, transcript }) + "\\n");

let additionalContext = "";
if (payload.hook_event_name === "SessionStart") {
  additionalContext = \`PROBE_SESSION_START_CONTEXT source=\${payload.source}\`;
} else if (payload.hook_event_name === "UserPromptSubmit") {
  additionalContext = \`PROBE_USER_PROMPT_CONTEXT prompt=\${payload.prompt}\`;
}
if (additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: payload.hook_event_name,
    additionalContext,
  }}));
}
`;
}

function productionHookScript(dispatchUrl: string, tracePath: string, restoredContext: string): string {
  return `
import { appendFileSync, readFileSync } from "node:fs";
import { dispatchCodexHook } from ${JSON.stringify(dispatchUrl)};

const raw = readFileSync(0, "utf8");
const event = JSON.parse(raw);
let transcriptProbe = null;
if (event.transcript_path) {
  try {
    const transcriptText = readFileSync(event.transcript_path, "utf8");
    const records = transcriptText.trimEnd().split("\\n").filter(Boolean).map(JSON.parse);
    transcriptProbe = {
      newlineTerminated: transcriptText.endsWith("\\n"),
      completeJson: true,
      compactedCount: records.filter((record) => record.type === "compacted").length,
      tailTypes: records.slice(-8).map((record) => record.type),
    };
  } catch {
    transcriptProbe = { newlineTerminated: false, completeJson: false, compactedCount: 0, tailTypes: [] };
  }
}
appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ event, transcriptProbe }) + "\\n");
const result = await dispatchCodexHook(raw, {
  connect: async () => true,
  client: {
    post: async (path, body) => {
      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ path, body }) + "\\n");
      if (path === "/restore") return { context: ${JSON.stringify(restoredContext)} };
      if (path === "/prompt-search") return { hints: ["NATIVE_PRODUCTION_PROMPT_HINT"], ids: ["native-production"] };
      return {};
    },
  },
});
if (result.stdout) process.stdout.write(result.stdout);
process.exitCode = result.exitCode;
`;
}

function responseEvents(isCompaction: boolean) {
  const outputText = isCompaction ? "COMPACT_SUMMARY_NATIVE" : "NATIVE_PROBE_OK";
  const inputTokens = isCompaction ? 1 : 50_000;
  const response = {
    id: "resp_native_lcm_probe",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "probe-model",
    output: [{
      id: "msg_native_lcm_probe",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }],
    }],
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: { input_tokens: inputTokens, output_tokens: 1, total_tokens: inputTokens + 1 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_native_lcm_probe", type: "message", status: "in_progress", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "msg_native_lcm_probe", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg_native_lcm_probe", output_index: 0, content_index: 0, delta: outputText },
    { type: "response.output_text.done", item_id: "msg_native_lcm_probe", output_index: 0, content_index: 0, text: outputText },
    { type: "response.content_part.done", item_id: "msg_native_lcm_probe", output_index: 0, content_index: 0, part: { type: "output_text", text: outputText, annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item: response.output[0] },
    { type: "response.completed", response },
  ];
}

function requestTexts(request: ResponseRequest): string[] {
  return (request.input ?? []).flatMap((item) => item.content ?? []).map((part) => part.text).filter((text): text is string => typeof text === "string");
}

function readHookRecords(path: string): HookRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as HookRecord);
}

async function startMockProvider(requests: ResponseRequest[]): Promise<number> {
  server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(raw) as ResponseRequest);
      const body = responseEvents(raw.includes("CONTEXT CHECKPOINT COMPACTION"))
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind a TCP port");
  return address.port;
}

afterEach(() => {
  server?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  server = undefined;
  tmpRoot = undefined;
});

describe.skipIf(!enabled)("Codex native lifecycle hooks", { timeout: 30_000 }, () => {
  it("executes vetted hooks with raw rollout timing on Codex CLI 0.153.4", async () => {
    const version = await run(["--version"]);
    expect(version.code, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe("codex-cli 0.153.4");

    tmpRoot = mkdtempSync(join(tmpdir(), "lcm-codex-native-runtime-"));
    const codexHome = join(tmpRoot, "home");
    const project = join(tmpRoot, "project");
    const hookPath = join(tmpRoot, "hook.mjs");
    const hookLog = join(tmpRoot, "hooks.jsonl");
    mkdirSync(codexHome);
    mkdirSync(project);
    writeFileSync(hookPath, hookScript(hookLog));
    writeFileSync(join(project, "AGENTS.md"), "Return the mock provider response without tool calls.\n");

    const requests: ResponseRequest[] = [];
    const providerPort = await startMockProvider(requests);

    writeFileSync(join(codexHome, "config.toml"), `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"
model_auto_compact_token_limit = 40000

[model_providers.probe]
name = "Local Probe"
base_url = "http://127.0.0.1:${providerPort}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`);
    const handler = { type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`, timeout: 10, additionalContextLimit: 4096 };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [handler] }],
      UserPromptSubmit: [{ hooks: [handler] }],
      Stop: [{ hooks: [{ ...handler, additionalContextLimit: undefined }] }],
      PreCompact: [{ matcher: "manual|auto", hooks: [{ ...handler, additionalContextLimit: undefined }] }],
      PostCompact: [{ matcher: "manual|auto", hooks: [{ ...handler, additionalContextLimit: undefined }] }],
    }}));

    const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "probe" };
    const baseArgs = ["exec", "--json", "--skip-git-repo-check", "-C", project];
    const untrusted = await run([...baseArgs, "--ephemeral", "Untrusted control turn."], env);
    expect(untrusted.code, untrusted.stderr).toBe(0);
    expect(readHookRecords(hookLog)).toEqual([]);
    expect(requestTexts(requests[0])).not.toContain("PROBE_SESSION_START_CONTEXT source=startup");

    const startupPrompt = "First persisted native turn.";
    const startup = await run([...baseArgs, "--dangerously-bypass-hook-trust", startupPrompt], env);
    expect(startup.code, startup.stderr).toBe(0);
    const threadEvent = startup.stdout.split("\n").map((line) => {
      try { return JSON.parse(line) as { type?: string; thread_id?: string }; } catch { return {}; }
    }).find((event) => event.type === "thread.started");
    expect(threadEvent?.thread_id).toBeTruthy();
    const sessionId = threadEvent!.thread_id!;

    const startupRecords = readHookRecords(hookLog).filter((record) => record.payload.session_id === sessionId);
    expect(startupRecords.map((record) => record.payload.hook_event_name)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
    expect(startupRecords[0].payload.source).toBe("startup");
    expect(startupRecords.every((record) => typeof record.payload.transcript_path === "string")).toBe(true);
    expect(requestTexts(requests[1])).toEqual(expect.arrayContaining([
      "PROBE_SESSION_START_CONTEXT source=startup",
      `PROBE_USER_PROMPT_CONTEXT prompt=${startupPrompt}`,
    ]));

    const resumedPrompt = "Distinct resumed prompt for timing.";
    const resumed = await run([...baseArgs, "--dangerously-bypass-hook-trust", "resume", sessionId, resumedPrompt], env);
    expect(resumed.code, resumed.stderr).toBe(0);
    const allRecords = readHookRecords(hookLog).filter((record) => record.payload.session_id === sessionId);
    const resumedRecords = allRecords.slice(3);
    expect(resumedRecords.map((record) => record.payload.hook_event_name)).toEqual([
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
    expect(resumedRecords.slice(0, 2).map((record) => record.payload.trigger)).toEqual(["auto", "auto"]);
    expect(resumedRecords.slice(2, 4).map((record) => record.payload.source)).toEqual(["resume", "compact"]);
    expect(requestTexts(requests[2]).some((text) => text.includes("CONTEXT CHECKPOINT COMPACTION"))).toBe(true);
    const continuationTexts = requestTexts(requests[3]);
    expect(continuationTexts.filter((text) => text.startsWith("PROBE_SESSION_START_CONTEXT"))).toEqual([
      "PROBE_SESSION_START_CONTEXT source=resume",
      "PROBE_SESSION_START_CONTEXT source=compact",
    ]);
    expect(continuationTexts).toContain(`PROBE_USER_PROMPT_CONTEXT prompt=${resumedPrompt}`);

    const promptRecord = resumedRecords[4];
    expect(promptRecord.transcript?.texts).not.toContain(resumedPrompt);
    const stopRecord = resumedRecords[5];
    expect(stopRecord.payload.last_assistant_message).toBe("NATIVE_PROBE_OK");
    expect(stopRecord.transcript?.texts).toEqual(expect.arrayContaining([resumedPrompt, "NATIVE_PROBE_OK"]));

    const transcriptPath = String(stopRecord.payload.transcript_path);
    const transcriptRows = readFileSync(transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(transcriptRows.some((row) => row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "assistant")).toBe(true);
  });

  it("deduplicates production restore context after native auto-compaction", async () => {
    const builtDispatch = join(process.cwd(), "dist/src/hooks/codex.js");
    expect(existsSync(builtDispatch), "Build the CLI before running native production hook tests").toBe(true);

    tmpRoot = mkdtempSync(join(tmpdir(), "lcm-codex-native-production-"));
    const codexHome = join(tmpRoot, "home");
    const project = join(tmpRoot, "project");
    const hookPath = join(tmpRoot, "production-hook.mjs");
    const tracePath = join(tmpRoot, "production-hook-trace.jsonl");
    const restoredContext = "## LCM context\n\n<lcm-context>\nLCM_NATIVE_RESTORED_CONTEXT\n</lcm-context>";
    mkdirSync(codexHome);
    mkdirSync(project);
    writeFileSync(hookPath, productionHookScript(pathToFileURL(builtDispatch).href, tracePath, restoredContext));
    writeFileSync(join(project, "AGENTS.md"), "Return the mock provider response without tool calls.\n");

    const requests: ResponseRequest[] = [];
    const providerPort = await startMockProvider(requests);
    writeFileSync(join(codexHome, "config.toml"), `
model = "probe-model"
model_provider = "probe"
approval_policy = "never"
sandbox_mode = "read-only"
model_auto_compact_token_limit = 40000

[model_providers.probe]
name = "Local Probe"
base_url = "http://127.0.0.1:${providerPort}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`);
    const handler = { type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`, timeout: 10, additionalContextLimit: 4096 };
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [handler] }],
      UserPromptSubmit: [{ hooks: [handler] }],
      Stop: [{ hooks: [{ ...handler, additionalContextLimit: undefined }] }],
      PreCompact: [{ matcher: "manual|auto", hooks: [{ ...handler, additionalContextLimit: undefined }] }],
    }}));

    const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "probe" };
    const baseArgs = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-C", project];
    const startup = await run([...baseArgs, "Seed production restore deduplication."], env);
    expect(startup.code, startup.stderr).toBe(0);
    const threadEvent = startup.stdout.split("\n").map((line) => {
      try { return JSON.parse(line) as { type?: string; thread_id?: string }; } catch { return {}; }
    }).find((event) => event.type === "thread.started");
    expect(threadEvent?.thread_id).toBeTruthy();
    const sessionId = threadEvent!.thread_id!;

    const resumedPrompt = "Continue through production restore deduplication.";
    const resumed = await run([...baseArgs, "resume", sessionId, resumedPrompt], env);
    expect(resumed.code, resumed.stderr).toBe(0);
    const secondResumedPrompt = "Continue through a second production compaction generation.";
    const secondResumed = await run([...baseArgs, "resume", sessionId, secondResumedPrompt], env);
    expect(secondResumed.code, secondResumed.stderr).toBe(0);

    const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const events = trace.filter((row) => row.event?.session_id === sessionId).map((row) => row.event);
    expect(events.map((event) => event.hook_event_name)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "SessionStart",
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "SessionStart",
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
    ]);
    expect(events.filter((event) => event.hook_event_name === "SessionStart").map((event) => event.source)).toEqual([
      "startup",
      "resume",
      "compact",
      "resume",
      "compact",
    ]);
    expect(trace.filter((row) => row.path === "/restore")).toHaveLength(5);

    const compactStarts = trace.filter((row) =>
      row.event?.hook_event_name === "SessionStart" && row.event.source === "compact"
    );
    expect(compactStarts).toHaveLength(2);
    expect(compactStarts.map((row) => row.transcriptProbe?.completeJson)).toEqual([true, true]);
    expect(compactStarts.map((row) => row.transcriptProbe?.newlineTerminated)).toEqual([true, true]);
    expect(compactStarts.map((row) => row.transcriptProbe?.compactedCount)).toEqual([1, 2]);

    expect(requestTexts(requests[1]).some((text) => text.includes("CONTEXT CHECKPOINT COMPACTION"))).toBe(true);
    const continuationTexts = requestTexts(requests[2]);
    expect(continuationTexts.filter((text) => text === restoredContext)).toEqual([restoredContext]);
    expect(continuationTexts).toContain(resumedPrompt);
    expect(requestTexts(requests[3]).some((text) => text.includes("CONTEXT CHECKPOINT COMPACTION"))).toBe(true);
    const secondContinuationTexts = requestTexts(requests[4]);
    expect(secondContinuationTexts.filter((text) => text === restoredContext)).toEqual([restoredContext]);
    expect(secondContinuationTexts).toContain(secondResumedPrompt);
  });
});
