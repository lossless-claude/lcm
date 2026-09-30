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
    }
  } finally { gate.resolve(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
