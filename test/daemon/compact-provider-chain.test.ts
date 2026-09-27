import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const home = mkdtempSync(`${os.tmpdir()}/lcm-chain-home-`);
  return { ...os, homedir: () => home };
});
import { homedir } from "node:os";
import { createCompactHandler } from "../../src/daemon/routes/compact.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectDbPath } from "../../src/daemon/project.js";
import type { RouteHandler } from "../../src/daemon/server.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { completion, httpError, startChatCompletionsServer } from "../helpers/chat-completions-server.js";

const paths = createLcmPaths(lcmHome());
let server: Awaited<ReturnType<typeof startChatCompletionsServer>>;
let cwd: string;
beforeAll(async () => {
  server = await startChatCompletionsServer();
  cwd = mkdtempSync(join(tmpdir(), "lcm-chain-"));
});
afterAll(async () => {
  await server.close();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homedir(), { recursive: true, force: true });
});

async function invoke(handler: RouteHandler, body: unknown): Promise<{ status: number; body: any }> {
  let status = 0;
  let result: any;
  await handler({} as any, { writeHead: (code: number) => { status = code; },
    end: (data: string) => { result = JSON.parse(data); } } as any, JSON.stringify(body));
  return { status, body: result };
}

it("records DeepSeek's cut-off answer as failed and OpenRouter's that replaced it as ok", async () => {
  server.answer("deepseek", completion("The session began with", "length", "deepseek-chat"));
  server.answer("openrouter", completion("the stored summary", "stop", "vendor/flash"));
  const config = loadDaemonConfig("/nonexistent", { llm: { provider: "deepseek", fallback: ["openrouter"], providers: {
    deepseek: { type: "openai", model: "deepseek-chat", baseURL: `${server.base}/deepseek`, body: { thinking: { type: "disabled" } } },
    openrouter: { type: "openai", model: "vendor/flash", baseURL: `${server.base}/openrouter`, body: { reasoning: { effort: "minimal" } } },
  } } }, {});
  const ingest = await invoke(createIngestHandler(config, paths), { cwd, session_id: "chain", messages:
    Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}`, tokenCount: 300 })) });
  expect(ingest.status).toBe(200);

  const result = await invoke(createCompactHandler(config, paths), { cwd, session_id: "chain" });

  expect(result.status).toBe(200);
  expect(result.body.replayOutcome).toBe("compacted");
  expect(result.body.providerId).toBe("openrouter");
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    const rows = db.prepare("SELECT provider, model, calls_total, calls_ok, calls_failed FROM llm_usage_stats").all() as
      { provider: string; model: string; calls_total: number; calls_ok: number; calls_failed: number }[];
    const deepseek = rows.find((row) => row.provider === "deepseek")!;
    const openrouter = rows.find((row) => row.provider === "openrouter")!;
    expect(rows.map((row) => row.provider).sort()).toEqual(["deepseek", "openrouter"]);
    expect(openrouter.calls_ok).toBeGreaterThan(0);
    expect(openrouter).toMatchObject({ model: "vendor/flash", calls_failed: 0, calls_total: openrouter.calls_ok });
    // Every pass tried DeepSeek first; none of its answers counts as a success.
    expect(deepseek).toMatchObject({ model: "deepseek-chat", calls_ok: 0, calls_failed: openrouter.calls_ok });
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE content = 'the stored summary'").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

/** An answer that carries no `usage`, as some OpenAI-compatible servers send. */
function unmetered(content: string) {
  const reply = completion(content, "stop", "served-model");
  delete (reply.body as { usage?: unknown }).usage;
  return reply;
}

async function compactFreshSession(config: ReturnType<typeof loadDaemonConfig>, sessionId: string) {
  const dir = mkdtempSync(join(tmpdir(), "lcm-chain-"));
  const ingest = await invoke(createIngestHandler(config, paths), { cwd: dir, session_id: sessionId, messages:
    Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `message ${i}`, tokenCount: 300 })) });
  expect(ingest.status).toBe(200);
  const result = await invoke(createCompactHandler(config, paths), { cwd: dir, session_id: sessionId });
  const db = new DatabaseSync(projectDbPath(dir, paths));
  try {
    const rows = db.prepare("SELECT provider, model, calls_total, calls_ok, calls_failed FROM llm_usage_stats ORDER BY provider").all();
    return { result, rows };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const namedEndpoints = (deepseekKey?: string) => ({
  deepseek: { type: "openai", model: "deepseek-chat", baseURL: `${server.base}/deepseek`, ...(deepseekKey ? { apiKey: deepseekKey } : {}) },
  openrouter: { type: "openai", model: "vendor/flash", baseURL: `${server.base}/openrouter` },
});

it("names the first runnable endpoint when the primary was left out and the answer reports no usage", async () => {
  server.reset();
  server.answer("openrouter", unmetered("the stored summary"));
  const config = loadDaemonConfig("/nonexistent", { llm: { provider: "deepseek", fallback: ["openrouter"],
    providers: namedEndpoints("${DEEPSEEK_API_KEY}") } }, {});

  const { result } = await compactFreshSession(config, "primary-left-out");

  expect(result.status).toBe(200);
  expect(result.body.providerId).toBe("openrouter");
  expect(server.seen.map((request) => request.endpoint)).not.toContain("deepseek");
});

it("records an endpoint that failed without usage, and names the unmetered endpoint that answered", async () => {
  server.reset();
  server.answer("deepseek", httpError(401, "invalid api key"));
  server.answer("openrouter", unmetered("the stored summary"));
  const config = loadDaemonConfig("/nonexistent", { llm: { provider: "deepseek", fallback: ["openrouter"],
    providers: namedEndpoints() } }, {});

  const { result, rows } = await compactFreshSession(config, "failed-unmetered");

  expect(result.status).toBe(200);
  expect(result.body.providerId).toBe("openrouter");
  // The model the handed-off endpoint is configured with, not the flat llm.model, which is empty here.
  expect(result.body.llmUsage).toMatchObject({ provider: "openrouter", model: "vendor/flash", okCalls: 0 });
  const deepseek = (rows as { provider: string; model: string; calls_total: number; calls_ok: number; calls_failed: number }[])
    .find((row) => row.provider === "deepseek");
  expect(deepseek).toMatchObject({ model: "deepseek-chat", calls_ok: 0 });
  expect(deepseek!.calls_failed).toBeGreaterThan(0);
  expect(deepseek!.calls_total).toBe(deepseek!.calls_failed);
});
