import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, expect, it, vi } from "vitest";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const home = mkdtempSync(`${os.tmpdir()}/lcm-rejection-home-`);
  return { ...os, homedir: () => home };
});
const { openai } = vi.hoisted(() => ({ openai: vi.fn() }));
vi.mock("../../src/llm/openai.js", () => ({ createOpenAISummarizer: () => openai }));
import { homedir } from "node:os";
import { createCompactHandler } from "../../src/daemon/routes/compact.js";
import { createIngestHandler } from "../../src/daemon/routes/ingest.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectDbPath } from "../../src/daemon/project.js";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";
import type { RouteHandler } from "../../src/daemon/server.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { SummaryRejectedError } from "../../src/llm/summary-rejection.js";

const paths = createLcmPaths(lcmHome());
const OPENAI_USAGE = { provider: "openai" as const, model: "reasoner", inputTokens: 15_000, outputTokens: 1_024, tokensUsed: 16_024 };
const cwds: string[] = [];

afterEach(() => {
  for (const cwd of cwds.splice(0)) rmSync(cwd, { recursive: true, force: true });
  vi.clearAllMocks();
});
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

async function invoke(handler: RouteHandler, body: unknown): Promise<{ status: number; body: any }> {
  let status = 0;
  let result: any;
  await handler({} as any, { writeHead: (code: number) => { status = code; },
    end: (data: string) => { result = JSON.parse(data); } } as any, JSON.stringify(body));
  return { status, body: result };
}

async function ingestedSession(config: ReturnType<typeof loadDaemonConfig>, sessionId: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-rejection-"));
  cwds.push(cwd);
  const ingest = await invoke(createIngestHandler(config, paths), { cwd, session_id: sessionId,
    messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user",
      content: `message ${i}`, tokenCount: 300 })),
  });
  expect(ingest.status).toBe(200);
  return cwd;
}

function readDb<T>(cwd: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try { return read(db); } finally { db.close(); }
}

const contextState = (db: DatabaseSync) => ({
  summaries: db.prepare("SELECT COUNT(*) AS n FROM summaries").get(),
  contextItems: db.prepare("SELECT ordinal, item_type, message_id, summary_id FROM context_items ORDER BY ordinal").all(),
});

it("finishes compaction despite repeated cuts and counts every rejected attempt as failed", async () => {
  openai.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage(OPENAI_USAGE);
    throw new SummaryRejectedError({ reason: "length", provider: "openai", model: "reasoner", maxOutputTokens: 1_024 });
  });
  const config = loadDaemonConfig("/x", { llm: { provider: "openai", model: "reasoner" } }, {});
  const cwd = await ingestedSession(config, "session-cut-off");

  const result = await invoke(createCompactHandler(config, paths), { cwd, session_id: "session-cut-off" });

  expect(result.status).toBe(200);
  expect(result.body.replayOutcome).toBe("compacted");
  const calls = openai.mock.calls.length;
  expect(calls).toBeGreaterThan(2);
  expect(result.body.llmUsage).toMatchObject({ calls, okCalls: 0, failedCalls: calls, tokensSpent: calls * 16_024 });
  readDb(cwd, (db) => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM summary_messages").get()).toEqual({ n: 32 });
    expect(db.prepare("SELECT provider, calls_total, calls_ok, calls_failed, tokens_output_total FROM llm_usage_stats").all())
      .toEqual([{ provider: "openai", calls_total: calls, calls_ok: 0, calls_failed: calls, tokens_output_total: calls * 1_024 }]);
  });
});

it("stores the shorter retry of a cut-off summary, counting the cut-off answer as its own failed call", async () => {
  const requests: Array<{ aggressive: boolean; maxOutputTokens?: number }> = [];
  openai.mockImplementation(async (_text: string, aggressive: boolean, ctx: any) => {
    requests.push({ aggressive, maxOutputTokens: ctx.maxOutputTokens });
    ctx.onUsage(OPENAI_USAGE);
    if (requests.length === 1) {
      throw new SummaryRejectedError({ reason: "length", provider: "openai", model: "reasoner", maxOutputTokens: 2_400 });
    }
    return "shorter summary";
  });
  const config = loadDaemonConfig("/x", { llm: { provider: "openai", model: "reasoner" } }, {});
  const cwd = await ingestedSession(config, "session-retried");

  const result = await invoke(createCompactHandler(config, paths), { cwd, session_id: "session-retried" });

  expect(result.status).toBe(200);
  expect(result.body.replayOutcome).toBe("compacted");
  expect(result.body.providerId).toBe("openai");
  // The retry asks for the shorter summary with twice the cap the first answer overran.
  expect(requests[1]).toEqual({ aggressive: true, maxOutputTokens: 4_800 });
  expect(result.body.llmUsage).toMatchObject({ calls: requests.length, okCalls: requests.length - 1, failedCalls: 1 });
  readDb(cwd, (db) => {
    const stored = db.prepare("SELECT COUNT(*) AS n FROM summaries").get() as { n: number };
    expect(stored.n).toBe(requests.length - 1);
    expect(db.prepare("SELECT provider, calls_total, calls_ok, calls_failed FROM llm_usage_stats").all())
      .toEqual([{ provider: "openai", calls_total: requests.length, calls_ok: requests.length - 1, calls_failed: 1 }]);
  });
});

it("counts an answer the engine rejects as a failed call, even when its adapter returned it", async () => {
  openai.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage(OPENAI_USAGE);
    return "  \n ";
  });
  const config = loadDaemonConfig("/x", { llm: { provider: "openai", model: "reasoner" } }, {});
  const cwd = await ingestedSession(config, "session-blank");
  const before = readDb(cwd, contextState);

  const result = await invoke(createCompactHandler(config, paths), { cwd, session_id: "session-blank" });

  expect(result.status).toBe(500);
  expect(result.body.error).toContain("summary rejected");
  readDb(cwd, (db) => {
    expect(contextState(db)).toEqual(before);
    expect(db.prepare("SELECT calls_ok, calls_failed FROM llm_usage_stats").all()).toEqual([{ calls_ok: 0, calls_failed: 1 }]);
  });
});

it("counts a rejected session answer as failed and the fallback that replaced it as ok", async () => {
  openai.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage(OPENAI_USAGE);
    return "fallback summary";
  });
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const sessionId = "session-rejected-answer";
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (job) jobs.answer(job.id, { text: "   ", providerId: "session:haiku",
        usage: { input_tokens: 20, output_tokens: 3, estimated: true } });
    }
  })();
  try {
    const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai", model: "reasoner" } }, {});
    const cwd = await ingestedSession(config, sessionId);

    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });

    expect(result.status).toBe(200);
    expect(result.body.replayOutcome).toBe("compacted");
    // The response names the provider whose answer was stored, not the one rejected before it.
    expect(result.body.providerId).toBe("openai");
    expect(result.body.llmUsage).toMatchObject({ provider: "openai", model: "reasoner" });
    expect(result.body.llmUsage.okCalls).toBeGreaterThan(0);
    expect(result.body.llmUsage.failedCalls).toBe(result.body.llmUsage.okCalls);
    readDb(cwd, (db) => {
      const rows = db.prepare("SELECT provider, calls_total, calls_ok, calls_failed FROM llm_usage_stats ORDER BY provider").all() as
        { provider: string; calls_total: number; calls_ok: number; calls_failed: number }[];
      const session = rows.find((row) => row.provider === "session:haiku")!;
      const fallback = rows.find((row) => row.provider === "openai")!;
      expect(session.calls_total).toBeGreaterThan(0);
      expect(session).toMatchObject({ calls_ok: 0, calls_failed: session.calls_total });
      expect(fallback).toMatchObject({ calls_ok: fallback.calls_total, calls_failed: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE content = 'fallback summary'").get()).toEqual({ n: 1 });
    });
  } finally {
    abort.abort();
    await serve;
    jobs.close();
  }
});

it("names the fallback whose answer was stored when the session's answer was discarded for not shrinking", async () => {
  openai.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage(OPENAI_USAGE);
    return "fallback summary";
  });
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const sessionId = "session-discarded-answer";
  // The session answers the first job with text longer than its source, so the engine
  // discards it and asks again aggressively; the session has gone, so the fallback answers.
  const tooLong = "unchanged ".repeat(20_000);
  let served = 0;
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (!job) continue;
      served += 1;
      jobs.answer(job.id, served === 1
        ? { text: tooLong, providerId: "session:haiku", usage: { input_tokens: 20, output_tokens: 50_000 } }
        : { error: "session gone" });
    }
  })();
  try {
    const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai", model: "reasoner" } }, {});
    const cwd = await ingestedSession(config, sessionId);

    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });

    expect(result.status).toBe(200);
    expect(served).toBeGreaterThan(1);
    expect(result.body.providerId).toBe("openai");
    expect(result.body.llmUsage).toMatchObject({ provider: "openai", model: "reasoner" });
    readDb(cwd, (db) => {
      expect(db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE content = 'fallback summary'").get()).toEqual({ n: 1 });
    });
  } finally {
    abort.abort();
    await serve;
    jobs.close();
  }
});

it("names a fallback that reports no usage when its answer replaced a rejected session answer", async () => {
  // Process-backed providers can answer without reporting usage; the handoff alone names them.
  openai.mockImplementation(async () => "fallback summary");
  const jobs = new SummarizeJobStore();
  const abort = new AbortController();
  const sessionId = "session-no-usage-fallback";
  const serve = (async () => {
    while (!abort.signal.aborted) {
      const job = await jobs.next(sessionId, abort.signal);
      if (job) jobs.answer(job.id, { text: "   ", providerId: "session:haiku",
        usage: { input_tokens: 20, output_tokens: 3, estimated: true } });
    }
  })();
  try {
    const config = loadDaemonConfig("/x", { llm: { provider: "session", fallbackProvider: "openai", model: "reasoner" } }, {});
    const cwd = await ingestedSession(config, sessionId);

    const result = await invoke(createCompactHandler(config, paths, jobs), { cwd, session_id: sessionId });

    expect(result.status).toBe(200);
    expect(result.body.providerId).toBe("openai");
    // The rejected session reported a model; the stored answer did not, so the run
    // reports the configured model, not the rejected one.
    expect(result.body.llmUsage).toMatchObject({ provider: "openai", model: "reasoner" });
  } finally {
    abort.abort();
    await serve;
    jobs.close();
  }
});

it("reports the configured model when the engine discarded every answer and stored its truncation", async () => {
  // Both the normal and the aggressive answer are longer than the source, so the engine
  // stores its deterministic truncation: no model's answer was kept.
  openai.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage({ ...OPENAI_USAGE, model: "discarded-model" });
    return "unchanged ".repeat(20_000);
  });
  const config = loadDaemonConfig("/x", { llm: { provider: "openai", model: "reasoner" } }, {});
  const cwd = await ingestedSession(config, "session-all-discarded");

  const result = await invoke(createCompactHandler(config, paths), { cwd, session_id: "session-all-discarded" });

  expect(result.status).toBe(200);
  expect(result.body.llmUsage.model).toBe("reasoner");
});
