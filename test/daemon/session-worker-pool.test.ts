import { assertWorkerCanaryAbsent, emptyWorkerConversation } from "../helpers/worker-canary.js";
import { registerWorkerSession } from "../../src/worker-session.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { createWorkerSessionHandler } from "../../src/daemon/routes/worker-session.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import { createSummarizer } from "../../src/daemon/summarizer.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createNextSummarizeJobHandler, createAnswerSummarizeJobHandler } from "../../src/daemon/routes/summarize-jobs.js";

it("round-trips K concurrent pool jobs through the provider, routes and K Claude workers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lcm-pool-workers-"));
  const paths = createLcmPaths(join(directory, "lcm"));
  const store = new SummarizeJobStore();
  const registration = createWorkerSessionHandler(paths, store);
  const nextJob = createNextSummarizeJobHandler(store, paths);
  const answer = createAnswerSummarizeJobHandler(store, paths);
  const gate = Promise.withResolvers<void>();
  const workers: any[] = [];
  try {
    for (const id of ["worker-1", "worker-2"]) {
      await emptyWorkerConversation(directory, id, paths);
      await registerWorkerSession(paths, { sessionId: id, cwd: directory, client: "claude", owner: `native:${id}` });
      vi.resetModules(); // Each host loads its own module environment.
      const handlers = new Map<string, any>();
      const engine = {
        env: { get: async (name: string) => name === "LCM_SUMMARIZE_WORKER" ? "1" : undefined },
        session: { id: async () => id, cwd: async () => directory },
        process: { run: async () => ({ stdout: "fake-token\n__CONFIG__\n{}\n__TMPDIR__/tmp", exitCode: 0 }) },
        fs: { write: vi.fn(async () => undefined) },
        ui: { log: vi.fn() },
        clock: { after: vi.fn(), sleep: () => new Promise<void>(() => {}) },
        model: {
          complete: vi.fn(async () => { await gate.promise; return { isAnswered: true, text: `summary by ${id}`, usage: { input_tokens: 10, output_tokens: 4 } }; }),
          fork: vi.fn(),
        },
        http: { fetch: async (url: string, init?: any) => {
          const path = new URL(url).pathname;
          if (path !== "/worker-session" && !path.startsWith("/summarize-jobs/")) return { ok: true, status: 200, text: "{}" };
          const res = Object.assign(new EventEmitter(), { destroyed: false, writeHead: vi.fn(), end: vi.fn() });
          const req = { url: new URL(url).pathname + new URL(url).search } as IncomingMessage;
          await (path === "/worker-session" ? registration : init?.method === "POST" ? answer : nextJob)(req, res as unknown as ServerResponse, init?.body ?? "");
          const status = res.writeHead.mock.calls[0][0];
          return { ok: status >= 200 && status < 300, status, text: res.end.mock.calls[0][0] ?? "" };
        } },
      };
      const { register } = await import("../../hooks/lcm-hooks.js");
      register(((event: string, ...args: any[]) => handlers.set(event, args.at(-1))) as any, { sessionSummarizerMaxOutputTokens: 4 });
      await handlers.get("session.start")(engine, {}, async (event: any) => event);
      workers.push(engine);
    }
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session-pool", fallbackProvider: "disabled" } }, {});
    const summarize = (await createSummarizer("session-pool", config, store))!;
    const pending = [summarize("private source A", false, { sessionId: "closed-a" }),
      summarize("private source B", false, { sessionId: "closed-b", isCondensed: true })];
    await vi.waitFor(() => expect(workers.every((worker) => worker.model.complete.mock.calls.length === 1)).toBe(true));
    expect(workers.every((worker) => worker.model.fork.mock.calls.length === 0)).toBe(true);
    gate.resolve();
    await expect(Promise.all(pending)).resolves.toEqual(["summary by worker-1", "summary by worker-2"]);
    const prompts = workers.map((worker) => worker.model.complete.mock.calls[0][0].prompt);
    expect(prompts[0]).toContain("private source A");
    expect(prompts[1]).toContain("private source B");
    for (const worker of workers) {
      expect(JSON.stringify(worker.fs.write.mock.calls)).not.toContain("private source");
      expect(worker.model.complete).toHaveBeenCalledOnce();
      await assertWorkerCanaryAbsent({ cwd: directory, sessionId: await worker.session.id(), paths, canary: "private source" });
    }
  } finally { gate.resolve(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("OMP hook pool canaries stay absent after capture, compaction and promotion attempts", async () => {
  const { default: lcm, __setTransportForTests, __setWorkerCompletionForTests, WORKER_WARNING } = await import("../../hooks/omp/lcm.js");
  expect(WORKER_WARNING).toBe((await import("../../src/worker-warning.js")).WORKER_WARNING);
  const cwd = mkdtempSync(join(tmpdir(), "lcm-omp-pool-canary-"));
  const paths = createLcmPaths(join(cwd, "lcm"));
  const jobs = new SummarizeJobStore();
  const registration = createWorkerSessionHandler(paths, jobs);
  const next = createNextSummarizeJobHandler(jobs, paths);
  const answer = createAnswerSummarizeJobHandler(jobs, paths);
  const canary = "FOREIGN_OMP_HOOK_CANARY_685";
  const complete = vi.fn(async (_model: unknown, input: any) => {
    expect(input.messages[0].content).toContain(canary);
    return { content: [{ type: "text", text: canary }], usage: { input: 10, output: 4 }, stopReason: "stop" };
  });
  vi.stubEnv("LCM_SUMMARIZE_WORKER", "1"); vi.stubEnv("LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS", "4");
  vi.stubEnv("LCM_HOME", paths.home);
  const handlers = new Map<string, any>();
  const sendMessage = vi.fn();
  try {
    await emptyWorkerConversation(cwd, "worker", paths);
    __setWorkerCompletionForTests(complete);
    __setTransportForTests(async request => {
      const route = request.path.split("?")[0];
      if (route !== "/worker-session" && !route.startsWith("/summarize-jobs/")) return {};
      const res = Object.assign(new EventEmitter(), { destroyed: false, writeHead: vi.fn(), end: vi.fn() });
      await (route === "/worker-session" ? registration : request.method === "GET" ? next : answer)(
        { url: request.path } as IncomingMessage, res as unknown as ServerResponse, JSON.stringify(request.body ?? {}));
      expect(res.writeHead.mock.calls[0][0]).toBe(200);
      return JSON.parse(res.end.mock.calls[0][0] ?? "{}");
    });
    lcm({ on: (name, handler) => handlers.set(name, handler), sendMessage, logger: { error: vi.fn() } });
    const pending = jobs.enqueue({ session_id: "foreign", pool: true, kind: "leaf", depth: 0,
      system: "system", prompt: canary, maxTokens: 100, targetTokens: 10 });
    const ctx = { cwd, sessionManager: { getSessionId: () => "worker", getSessionFile: () => join(cwd, "worker.jsonl"), isSessionOnDisk: () => false },
      modelRegistry: { getAll: () => [{ id: "claude-haiku-4-5", provider: "anthropic" }], getApiKey: async () => "fake-key" } };
    await handlers.get("session_start")({ source: "startup" }, ctx);
    await expect(pending).resolves.toMatchObject({ text: canary, providerId: "session-pool:haiku" });
    expect(complete).toHaveBeenCalledOnce(); expect(sendMessage).not.toHaveBeenCalled();
    await assertWorkerCanaryAbsent({ cwd, sessionId: "worker", paths, canary });
    await handlers.get("session_shutdown")({}, ctx);
  } finally {
    jobs.close(); __setTransportForTests(); __setWorkerCompletionForTests(); vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
