import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, expect, vi } from "vitest";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const home = mkdtempSync(`${os.tmpdir()}/lcm-session-home-`);
  return { ...os, homedir: () => home };
});
vi.mock("../../src/llm/openai.js", () => ({
  createOpenAISummarizer: () => async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage({ provider: "openai", model: "fallback-model", inputTokens: 10,
      outputTokens: 2, tokensUsed: 12 });
    return "fallback summary";
  },
}));
import { homedir } from "node:os";
import { createCompactHandler } from "../../src/daemon/routes/compact.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectDbPath } from "../../src/daemon/project.js";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import type { RouteHandler } from "../../src/daemon/server.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());

async function invoke(handler: RouteHandler, body: unknown) {
  let status = 0;
  let result: any;
  await handler({} as any, { writeHead: (code: number) => { status = code; },
    end: (data: string) => { result = JSON.parse(data); } } as any, JSON.stringify(body));
  expect(status).toBe(200);
  return result;
}

it.each([false, true])("keeps live jobs session-owned while replay can select the pool (pool=%s)", async (pool) => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-compact-"));
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "disabled" } }, {});
  const sessionId = "closed-source-session";
  let served = 0;
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = pool ? await jobs.nextWorker("dedicated-worker", abort.signal)
        : await jobs.next(sessionId, abort.signal);
      if (!job) continue;
      expect(job.session_id).toBe(sessionId);
      expect(job.pool === true).toBe(pool);
      served++;
      jobs.answer(job.id, { text: "isolated summary", providerId: pool ? "session-pool:sonnet" : "session:haiku",
        usage: { input_tokens: 10, output_tokens: 4, estimated: false } });
    }
  })();
  try {
    await invoke(createIngestHandler(config, paths), { cwd, session_id: sessionId,
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
        content: `source message ${i}`, tokenCount: 300 })),
    });
    const result = await invoke(createCompactHandler(config, paths, jobs), {
      cwd, session_id: sessionId, skip_ingest: true,
      ...(pool ? { replay_provider: "session-pool" } : {}),
    });
    expect(result.replayOutcome).toBe("compacted");
    expect(served).toBeGreaterThan(0);
    expect(result.providerId).toBe(pool ? "session-pool:sonnet" : "session:haiku");
    expect(config.llm.provider).toBe("session");
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      expect(db.prepare("SELECT content FROM summaries WHERE content = 'isolated summary'").all().length).toBeGreaterThan(0);
      expect(db.prepare("SELECT provider, calls_ok FROM llm_usage_stats").all()).toEqual([
        { provider: pool ? "session-pool:sonnet" : "session:haiku", calls_ok: served },
      ]);
    } finally { db.close(); }
  } finally {
    abort.abort();
    await serve;
    jobs.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each([
  { skip_ingest: false },
  { skip_ingest: true, capture_required: true },
  { skip_ingest: true, precompact_verified: true },
])("rejects a replay pool override on live capture requests: %j", async (flags) => {
  const config = loadDaemonConfig("/x", {}, {});
  const handler = createCompactHandler(config, paths);
  const res = { writeHead: vi.fn(), end: vi.fn() };
  await handler({} as any, res as any, JSON.stringify({ replay_provider: "session-pool", ...flags }));
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ error: expect.stringContaining("replay_provider") });
});

it("compacts through the session queue and persists actual provider and estimated usage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-session-roundtrip-"));
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
  const sessionId = "session-roundtrip";
  let served = 0;
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (!job) continue;
      jobs.answer(job.id, served++ === 0 ? { error: "model unavailable" } : {
        text: "live session summary", providerId: "session:haiku",
        usage: { input_tokens: 20, output_tokens: 4, estimated: true },
      });
    }
  })();
  try {
    await invoke(createIngestHandler(config, paths), { cwd, session_id: sessionId,
      messages: Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
        content: `message ${i}`, tokenCount: 300 })),
    });
    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });
    expect(result.replayOutcome).toBe("compacted");
    expect(served).toBeGreaterThan(1);
    // Two providers answered in this run, so the response keeps the configured name.
    expect(result.providerId).toBe("session");
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      expect(db.prepare("SELECT * FROM llm_usage_stats ORDER BY provider").all()).toEqual([
        expect.objectContaining({ provider: "openai", model: "fallback-model", calls_total: 1, calls_estimated: 0 }),
        expect.objectContaining({ provider: "session:haiku", model: "haiku", calls_estimated: served - 1 }),
      ]);
      expect(db.prepare("SELECT content FROM summaries WHERE content = 'live session summary'").all().length).toBeGreaterThan(0);
    } finally { db.close(); }
  } finally {
    abort.abort();
    await serve;
    jobs.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homedir(), { recursive: true, force: true });
  }
});

it("counts unanswered session attempts as failed and attributes the answering provider", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-session-attempts-"));
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
  const sessionId = "session-attempts";
  let served = 0;
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (!job) continue;
      served++;
      jobs.answer(job.id, { text: "live session summary", providerId: "session:haiku",
        usage: { input_tokens: 3, output_tokens: 2, estimated: true },
        usageAttempts: [{ providerId: "session:fork", failed: true,
          usage: { input_tokens: 40, output_tokens: 7, estimated: false } }],
      });
    }
  })();
  try {
    await invoke(createIngestHandler(config, paths), { cwd, session_id: sessionId,
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
        content: `message ${i}`, tokenCount: 300 })),
    });
    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });
    expect(served).toBeGreaterThan(0);
    expect(result.providerId).toBe("session:haiku");
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      expect(db.prepare("SELECT provider, calls_total, calls_ok, calls_failed FROM llm_usage_stats ORDER BY provider").all())
        .toMatchObject([
          { provider: "session:fork", calls_total: served, calls_ok: 0, calls_failed: served },
          { provider: "session:haiku", calls_total: served, calls_ok: served, calls_failed: 0 },
        ]);
    } finally { db.close(); }
  } finally {
    abort.abort();
    await serve;
    jobs.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("keeps a cap-discarded answered attempt successful without attributing the fallback to it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-session-cap-attempt-"));
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
  const sessionId = "cap-attempt";
  let served = 0;
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (!job) continue;
      served++;
      jobs.answer(job.id, { error: "spend cap", usageAttempts: [{ providerId: "session:haiku", failed: false,
        usage: { input_tokens: 3, output_tokens: 2, estimated: true } }] });
    }
  })();
  try {
    await invoke(createIngestHandler(config, paths), { cwd, session_id: sessionId,
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
        content: `message ${i}`, tokenCount: 300 })),
    });
    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });
    expect(served).toBeGreaterThan(0);
    expect(result.providerId).toBe("openai");
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      expect(db.prepare("SELECT provider, calls_ok, calls_failed FROM llm_usage_stats WHERE provider = 'session:haiku'").get())
        .toMatchObject({ provider: "session:haiku", calls_ok: served, calls_failed: 0 });
    } finally { db.close(); }
  } finally {
    abort.abort();
    await serve;
    jobs.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("names the fallback provider in the response when no session served a job", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-session-fallback-"));
  const jobs = new SummarizeJobStore(50); // nobody polls: every job expires at once
  const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai" } }, {});
  try {
    await invoke(createIngestHandler(config, paths), { cwd, session_id: "session-unserved",
      messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
        content: `message ${i}`, tokenCount: 300 })),
    });
    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: "session-unserved" });
    expect(result.replayOutcome).toBe("compacted");
    expect(result.providerId).toBe("openai");
    expect(result.providerLabel).toBe("OpenAI API");
    expect(result.llmUsage).toEqual(expect.objectContaining({ provider: "openai" }));
  } finally {
    jobs.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homedir(), { recursive: true, force: true });
  }
});
