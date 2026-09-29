import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectDir, projectId, projectMetaPath } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { clearReplayState, createReplayRun } from "../../../src/replay-resume.js";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { eventsDbPath } from "../../../src/db/events-path.js";

const paths = createLcmPaths(lcmHome());

// --- Summarizer branching unit tests ---

vi.mock("../../../src/llm/anthropic.js", () => ({
  createAnthropicSummarizer: vi.fn().mockReturnValue(async () => "anthropic-summary"),
}));

vi.mock("../../../src/llm/openai.js", () => ({
  createOpenAISummarizer: vi.fn().mockReturnValue(async () => "openai-summary"),
}));

vi.mock("../../../src/llm/claude-process.js", () => ({
  createClaudeProcessSummarizer: vi.fn().mockReturnValue(async () => "claude-process-summary"),
}));

vi.mock("../../../src/llm/codex-process.js", () => ({
  createCodexProcessSummarizer: vi.fn().mockReturnValue(async () => "codex-process-summary"),
}));

vi.mock("../../../src/llm/copilot-process.js", () => ({
  createCopilotProcessSummarizer: vi.fn().mockReturnValue(async () => "copilot-process-summary"),
}));

vi.mock("../../../src/llm/omp-process.js", () => ({
  createOmpProcessSummarizer: vi.fn().mockReturnValue(async () => "omp-process-summary"),
}));

vi.mock("../../../src/daemon/project-language.js", () => ({
  scheduleProjectLanguageDetection: vi.fn().mockResolvedValue(undefined),
}));

import { createClaudeProcessSummarizer } from "../../../src/llm/claude-process.js";
import { createCopilotProcessSummarizer } from "../../../src/llm/copilot-process.js";
import { createCodexProcessSummarizer } from "../../../src/llm/codex-process.js";
import { createOmpProcessSummarizer } from "../../../src/llm/omp-process.js";
import { createAnthropicSummarizer } from "../../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../../src/llm/openai.js";
import { scheduleProjectLanguageDetection } from "../../../src/daemon/project-language.js";
import { createCompactHandler, buildCompactionMessage, markCompacting } from "../../../src/daemon/routes/compact.js";
import { createIngestHandler } from "../../../src/daemon/routes/ingest.js";
import { enqueue } from "../../../src/daemon/project-queue.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function makeConfig(provider: DaemonConfig["llm"]["provider"]): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      autoCompactMinTokens: 10000,
      promotionThresholds: { minDepth: 2, compressionRatio: 0.3, keywords: {}, architecturePatterns: [], dedupBm25Threshold: 15, dedupCandidateLimit: 3 },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: { provider, model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
    security: { sensitivePatterns: [] },
    summarizer: { mock: false },
  } as unknown as DaemonConfig;
}

describe("required pre-compaction capture", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("captures before reporting a disabled summarizer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-disabled-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "captured before disabled summary" } }) + "\n");
    const { res, getBody } = mockRes();

    await createCompactHandler(makeConfig("disabled"), paths)({} as any, res, JSON.stringify({
      session_id: "precompact-disabled", cwd, transcript_path: transcriptPath, capture_required: true,
    }));

    expect(getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
    expect(getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(await readMessageCount(cwd, "precompact-disabled")).toBe(1);
    const observations = new EventsDb(eventsDbPath(cwd, paths));
    try {
      expect(observations.getHookObservationSummary("precompact-disabled")).toMatchObject([
        { operation: "capture", status: "completed", count: 1 },
        { operation: "summary", status: "skipped", reason: "disabled", count: 1 },
      ]);
    } finally {
      observations.close();
    }
  });

  it("retains both Sessions when callers reuse a pre-compaction operation id", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-shared-id-"));
    dirs.push(cwd);
    const handler = createCompactHandler(makeConfig("disabled"), paths);
    for (const sessionId of ["first-session", "second-session"]) {
      const transcriptPath = join(cwd, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: sessionId } }) + "\n");
      const { res } = mockRes();
      await handler({} as any, res, JSON.stringify({
        session_id: sessionId, cwd, transcript_path: transcriptPath,
        capture_required: true, operation_id: "shared-operation",
      }));
    }
    const observations = new EventsDb(eventsDbPath(cwd, paths));
    try {
      for (const sessionId of ["first-session", "second-session"]) {
        expect(observations.getHookObservationSummary(sessionId)).toEqual(expect.arrayContaining([
          expect.objectContaining({ operation: "capture", status: "completed", count: 1 }),
          expect.objectContaining({ operation: "summary", status: "skipped", reason: "disabled", count: 1 }),
        ]));
      }
    } finally {
      observations.close();
    }
  });

  it("skips lcm summarization when no transcript source is available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-no-source-"));
    dirs.push(cwd);
    const { res, getBody } = mockRes();

    await createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
      session_id: "precompact-no-source", cwd, client: "omp", capture_required: true,
    }));

    expect(getBody().captureOutcome).toMatchObject({ status: "deferred", reason: "no-capture-result" });
    expect(getBody().summary).toBe("");
    expect(getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "capture-deferred" });
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("keeps capture failure separate from a skipped summary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-bad-source-"));
    dirs.push(cwd);
    const { res, getBody } = mockRes();

    await createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
      session_id: "precompact-bad-source", cwd, client: "omp",
      transcript_path: join(cwd, "missing.jsonl"), capture_required: true,
    }));

    expect(getBody().captureOutcome.status).toBe("failed");
    expect(getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "capture-failed" });
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("captures even when another summary for the session is busy", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-busy-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "captured while busy" } }) + "\n");
    const release = markCompacting("precompact-busy", cwd);
    const { res, getBody } = mockRes();
    try {
      await createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
        session_id: "precompact-busy", cwd, transcript_path: transcriptPath, capture_required: true,
      }));
    } finally {
      release();
    }

    expect(getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
    expect(getBody().summary).toBe("");
    expect(getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "busy" });
    expect(await readMessageCount(cwd, "precompact-busy")).toBe(1);
  });

  it("keeps busy pre-compaction output empty without a Capture source", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-busy-no-source-"));
    dirs.push(cwd);
    const release = markCompacting("precompact-busy-no-source", cwd);
    try {
      const hook = mockRes();
      await createCompactHandler(makeConfig("openai"), paths)({} as any, hook.res, JSON.stringify({
        session_id: "precompact-busy-no-source", cwd, client: "omp", capture_required: true,
      }));
      expect(hook.getBody().captureOutcome).toMatchObject({ status: "deferred", reason: "no-capture-result" });
      expect(hook.getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "busy" });
      expect(hook.getBody().summary).toBe("");

      const replay = mockRes();
      await createCompactHandler(makeConfig("openai"), paths)({} as any, replay.res, JSON.stringify({
        session_id: "precompact-busy-no-source", cwd, skip_ingest: true,
      }));
      expect(replay.getBody().summary).toContain("already in progress");
    } finally {
      release();
    }
  });

  it("returns separate outcomes when busy Capture rejects an invalid source", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-busy-invalid-"));
    dirs.push(cwd);
    const release = markCompacting("busy-invalid", cwd);
    try {
      const { res, getBody } = mockRes();
      await createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
        session_id: "busy-invalid", cwd, client: "omp", capture_required: true,
        transcript_path: join(cwd, "missing.jsonl"),
      }));
      expect(getBody().captureOutcome).toMatchObject({ status: "failed", reason: "invalid-source" });
      expect(getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "busy" });
    } finally {
      release();
    }
  });

  it("captures while the project queue is occupied by an active summary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-queued-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "tail while LLM waits" } }) + "\n");
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const queued = enqueue(projectId(cwd), async () => { entered.resolve(); await unblock.promise; });
    await entered.promise;
    const release = markCompacting("another-session", cwd);
    const { res, getBody } = mockRes();
    const request = createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
      session_id: "precompact-queued", cwd, transcript_path: transcriptPath, capture_required: true,
    }));
    try {
      expect(await Promise.race([request.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))])).toBe(true);
      expect(getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
    } finally {
      unblock.resolve();
      await queued;
      await request;
      release();
    }
  });

  it("captures a transcript tail while an earlier summary waits for its LLM", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-live-summary-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const first = mockRes();
    const compacting = handler({} as any, first.res, JSON.stringify({
      session_id: "live-summary", cwd, transcript_path: transcriptPath,
    }));
    try {
      await Promise.race([entered.promise, compacting.then(() => { throw new Error("summary did not reach LLM"); })]);
      appendFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "new tail while LLM waits" } }) + "\n");
      const second = mockRes();
      const capture = handler({} as any, second.res, JSON.stringify({
        session_id: "live-summary", cwd, transcript_path: transcriptPath, capture_required: true,
      }));
      expect(await Promise.race([capture.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(second.getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
      expect(second.getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "busy" });
    } finally {
      resume.resolve();
      await compacting;
    }
    expect(await readMessageContents(cwd, "live-summary")).toContain("new tail while LLM waits");
  }, 10_000);

  it("admits another session's PreCompact while a summary waits, but skips the same session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-yielded-summary-"));
    dirs.push(cwd);
    const firstTranscript = join(cwd, "first.jsonl");
    const secondTranscript = join(cwd, "second.jsonl");
    writeFileSync(firstTranscript, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    writeFileSync(secondTranscript, JSON.stringify({ message: { role: "user", content: "second session captured" } }) + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const first = mockRes();
    const compacting = handler({} as any, first.res, JSON.stringify({
      session_id: "first-session", cwd, transcript_path: firstTranscript,
    }));
    try {
      await Promise.race([entered.promise, compacting.then(() => { throw new Error("summary did not reach LLM"); })]);
      const same = mockRes();
      await handler({} as any, same.res, JSON.stringify({
        session_id: "first-session", cwd, transcript_path: firstTranscript, capture_required: true,
      }));
      expect(same.getBody().summaryOutcome).toMatchObject({ status: "skipped", reason: "busy" });

      const other = mockRes();
      const precompact = handler({} as any, other.res, JSON.stringify({
        session_id: "second-session", cwd, transcript_path: secondTranscript, capture_required: true,
      }));
      expect(await Promise.race([precompact.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(other.getBody().skipped).not.toBe(true);
      expect(other.getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
      expect(await readMessageContents(cwd, "second-session")).toContain("second session captured");
    } finally {
      resume.resolve();
      await compacting;
    }
  }, 10_000);

  it("waits for the same session's summary before a second direct /compact", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-same-session-summary-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const summarize = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(summarize);
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const first = mockRes();
    const firstRequest = handler({} as any, first.res, JSON.stringify({
      session_id: "same-session", cwd, transcript_path: transcriptPath,
    }));
    let secondRequest: Promise<void> | undefined;
    try {
      await entered.promise;
      const second = mockRes();
      secondRequest = handler({} as any, second.res, JSON.stringify({
        session_id: "same-session", cwd, transcript_path: transcriptPath,
      }));
      expect(await Promise.race([
        secondRequest.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])).toBe(false);
      const replay = mockRes();
      await handler({} as any, replay.res, JSON.stringify({
        session_id: "same-session", cwd, skip_ingest: true,
      }));
      expect(replay.getBody().replayOutcome).toBe("skipped");
      resume.resolve();
      await firstRequest;
      const summariesAfterFirst = await readSummaryCount(cwd, "same-session");
      expect(summariesAfterFirst).toBeGreaterThan(0);
      await secondRequest;
      expect(first.getBody().replayOutcome).toBe("compacted");
      expect(second.getBody().replayOutcome).toBe("no_work");
      expect(await readSummaryCount(cwd, "same-session")).toBe(summariesAfterFirst);
      expect(summarize).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      await firstRequest;
      await secondRequest;
    }
  }, 10_000);

  it("captures the compacting session through /ingest while its summary waits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-same-session-ingest-"));
    dirs.push(cwd);
    const ingestHandler = createIngestHandler(makeConfig("disabled"), paths);
    const seed = mockRes();
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index} ${"content for compaction ".repeat(100)}`,
      tokenCount: 600,
    }));
    await ingestHandler({} as any, seed.res, JSON.stringify({
      session_id: "capturing-session", cwd, messages,
    }));
    expect(seed.getBody()).toMatchObject({ ingested: 20 });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const summarize = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(summarize);
    const compact = mockRes();
    const compacting = createCompactHandler(makeConfig("openai"), paths)({} as any, compact.res, JSON.stringify({
      session_id: "capturing-session", cwd, skip_ingest: true,
    }));
    try {
      await entered.promise;
      const tail = mockRes();
      const capturing = ingestHandler({} as any, tail.res, JSON.stringify({
        session_id: "capturing-session", cwd,
        messages: [...messages, { role: "user", content: "new tail while summary waits", tokenCount: 7 }],
      }));
      expect(await Promise.race([
        capturing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])).toBe(true);
      expect(tail.getBody()).toMatchObject({ ingested: 1 });
    } finally {
      resume.resolve();
      await compacting;
    }
    expect(compact.getBody().replayOutcome).toBe("compacted");
    expect(await readMessageContents(cwd, "capturing-session")).toContain("new tail while summary waits");
    expect(await readContextMessageContents(cwd, "capturing-session")).toContain("new tail while summary waits");
    expect(summarize.mock.calls.every(([text]) => !String(text).includes("new tail while summary waits"))).toBe(true);
  }, 10_000);

  it("holds a rebuild of the compacting session until its summary is written", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-same-session-rebuild-"));
    dirs.push(cwd);
    const ingestHandler = createIngestHandler(makeConfig("disabled"), paths);
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message ${index} ${"content for compaction ".repeat(100)}`,
      tokenCount: 600,
    }));
    const seed = mockRes();
    await ingestHandler({} as any, seed.res, JSON.stringify({ session_id: "rebuilt-session", cwd, messages }));
    expect(seed.getBody()).toMatchObject({ ingested: 20 });
    // The transcript holds a message the stored history skipped, so the rebuild rewrites every row.
    const transcriptPath = join(cwd, "rebuilt-session.jsonl");
    const transcript = [...messages.slice(0, 10), { role: "user", content: "skipped by the stored history" }, ...messages.slice(10)];
    writeFileSync(transcriptPath, transcript.map(({ role, content }) => JSON.stringify({ message: { role, content } })).join("\n") + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    const compact = mockRes();
    const compacting = createCompactHandler(makeConfig("openai"), paths)({} as any, compact.res, JSON.stringify({
      session_id: "rebuilt-session", cwd, skip_ingest: true,
    }));
    const rebuild = mockRes();
    let rebuilding: Promise<void> | undefined;
    try {
      await entered.promise;
      rebuilding = ingestHandler({} as any, rebuild.res, JSON.stringify({
        session_id: "rebuilt-session", cwd, client: "claude", transcript_path: transcriptPath, rebuild: true,
      }));
      expect(await Promise.race([
        rebuilding.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ])).toBe(false);
    } finally {
      resume.resolve();
      await compacting;
      await rebuilding;
    }
    expect(compact.getBody().replayOutcome).toBe("compacted");
    expect(rebuild.getBody()).toMatchObject({ rebuild: { kind: "repairable" } });
    expect(await readMessageContents(cwd, "rebuilt-session")).toContain("skipped by the stored history");
  }, 10_000);

  it("lets two sessions of one project summarize at the same time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-two-summaries-"));
    dirs.push(cwd);
    const requests = ["first-session", "second-session"].map((sessionId) => {
      const transcriptPath = join(cwd, `${sessionId}.jsonl`);
      writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
        message: { role: index % 2 ? "assistant" : "user",
          content: `message ${index} ${"content for compaction ".repeat(100)}` },
      })).join("\n") + "\n");
      return { sessionId, transcriptPath, response: mockRes() };
    });
    const firstEntered = Promise.withResolvers<void>();
    const bothEntered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let calls = 0;
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      calls++;
      if (calls === 1) firstEntered.resolve();
      if (calls === 2) bothEntered.resolve();
      await resume.promise;
      return "summary";
    });
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const run = (request: typeof requests[number]) => handler({} as any, request.response.res, JSON.stringify({
      session_id: request.sessionId, cwd, transcript_path: request.transcriptPath,
    }));
    const first = run(requests[0]!);
    let second: Promise<void> | undefined;
    try {
      await firstEntered.promise;
      second = run(requests[1]!);
      expect(await Promise.race([
        bothEntered.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])).toBe(true);
    } finally {
      resume.resolve();
      await first;
      await second;
    }
    expect(requests.map((request) => request.response.getBody().replayOutcome)).toEqual(["compacted", "compacted"]);
  }, 10_000);

  it("does not block the same session id in another project", async () => {
    const projects = [0, 1].map(() => mkdtempSync(join(tmpdir(), "lcm-shared-session-id-")));
    dirs.push(...projects);
    const entered = Promise.withResolvers<void>();
    const bothEntered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let calls = 0;
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      calls++;
      if (calls === 1) entered.resolve();
      if (calls === 2) bothEntered.resolve();
      await resume.promise;
      return "summary";
    });
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const run = (cwd: string, response: ReturnType<typeof mockRes>) => {
      const transcriptPath = join(cwd, "session.jsonl");
      writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
        message: { role: index % 2 ? "assistant" : "user",
          content: `message ${index} ${"content for compaction ".repeat(100)}` },
      })).join("\n") + "\n");
      return handler({} as any, response.res, JSON.stringify({
        session_id: "shared-session", cwd, transcript_path: transcriptPath,
      }));
    };
    const responses = [mockRes(), mockRes()];
    const first = run(projects[0]!, responses[0]!);
    let second: Promise<void> | undefined;
    try {
      await entered.promise;
      second = run(projects[1]!, responses[1]!);
      expect(await Promise.race([
        bothEntered.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])).toBe(true);
    } finally {
      resume.resolve();
      await first;
      await second;
    }
    expect(responses.map((response) => response.getBody().replayOutcome)).toEqual(["compacted", "compacted"]);
  }, 10_000);

  it("completes another session's /ingest while a summary waits for its LLM", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-ingest-during-summary-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "summary.jsonl");
    writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    const compact = mockRes();
    const compacting = createCompactHandler(makeConfig("openai"), paths)({} as any, compact.res, JSON.stringify({
      session_id: "summary-session", cwd, transcript_path: transcriptPath,
    }));
    try {
      await Promise.race([entered.promise, compacting.then(() => { throw new Error("summary did not reach LLM"); })]);
      const ingest = mockRes();
      const capturing = createIngestHandler(makeConfig("disabled"), paths)({} as any, ingest.res, JSON.stringify({
        session_id: "live-session", cwd,
        messages: [{ role: "user", content: "captured during summary", tokenCount: 3 }],
      }));
      expect(await Promise.race([capturing.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(ingest.getBody()).toMatchObject({ ingested: 1 });
    } finally {
      resume.resolve();
      await compacting;
    }
  }, 10_000);

  it("captures another /compact session while a summary waits for its LLM", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-compact-during-summary-"));
    dirs.push(cwd);
    const firstTranscript = join(cwd, "first.jsonl");
    const secondTranscript = join(cwd, "second.jsonl");
    writeFileSync(firstTranscript, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    writeFileSync(secondTranscript, JSON.stringify({ message: { role: "user", content: "another capture" } }) + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
      entered.resolve();
      await resume.promise;
      return "summary";
    });
    const first = mockRes();
    const compacting = createCompactHandler(makeConfig("openai"), paths)({} as any, first.res, JSON.stringify({
      session_id: "first-session", cwd, transcript_path: firstTranscript,
    }));
    try {
      await Promise.race([entered.promise, compacting.then(() => { throw new Error("summary did not reach LLM"); })]);
      const second = mockRes();
      const capturing = createCompactHandler(makeConfig("openai"), paths)({} as any, second.res, JSON.stringify({
        session_id: "second-session", cwd, transcript_path: secondTranscript,
      }));
      expect(await Promise.race([capturing.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(await readMessageContents(cwd, "second-session")).toContain("another capture");
    } finally {
      resume.resolve();
      await compacting;
    }
  }, 10_000);

  it("captures while language detection awaits an external model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-detect-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, Array.from({ length: 20 }, (_, index) => JSON.stringify({
      message: { role: index % 2 ? "assistant" : "user",
        content: `message ${index} ${"content for compaction ".repeat(100)}` },
    })).join("\n") + "\n");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(scheduleProjectLanguageDetection).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const first = mockRes();
    const compacting = handler({} as any, first.res, JSON.stringify({
      session_id: "detect-session", cwd, transcript_path: transcriptPath,
    }));
    try {
      await Promise.race([entered.promise, compacting.then(() => { throw new Error("language detection did not start"); })]);
      appendFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "tail during detection" } }) + "\n");
      const second = mockRes();
      const capture = handler({} as any, second.res, JSON.stringify({
        session_id: "detect-session", cwd, transcript_path: transcriptPath, capture_required: true,
      }));
      expect(await Promise.race([capture.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(second.getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
    } finally {
      resume.resolve();
      await compacting;
    }
  }, 10_000);

  it("waits for an active ingest transaction without blocking its commit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-ingest-lease-"));
    dirs.push(cwd);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ message: { role: "user", content: "capture after ingest" } }) + "\n");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = ConversationStore.prototype.withTransaction;
    const spy = vi.spyOn(ConversationStore.prototype, "withTransaction").mockImplementationOnce(function (operation) {
      return original.call(this, async () => {
        entered.resolve();
        await release.promise;
        return operation();
      });
    });
    const first = mockRes();
    const ingesting = createIngestHandler(makeConfig("disabled"), paths)({} as any, first.res, JSON.stringify({
      session_id: "other-session", cwd,
      messages: [{ role: "user", content: "first writer", tokenCount: 2 }],
    }));
    try {
      await entered.promise;
      const second = mockRes();
      const capture = createCompactHandler(makeConfig("disabled"), paths)({} as any, second.res, JSON.stringify({
        session_id: "precompact-session", cwd, transcript_path: transcriptPath, capture_required: true,
      }));
      expect(await Promise.race([capture.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]))
        .toBe(false);
      release.resolve();
      await Promise.all([ingesting, capture]);
      expect(second.getBody().captureOutcome).toMatchObject({ status: "completed", messages: 1 });
    } finally {
      release.resolve();
      spy.mockRestore();
      await ingesting;
    }
  }, 10_000);

  it("records the OMP summary outcome after its separately confirmed capture", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-omp-"));
    dirs.push(cwd);
    const { res } = mockRes();
    await createCompactHandler(makeConfig("disabled"), paths)({} as any, res, JSON.stringify({
      session_id: "omp-precompact", cwd, client: "omp", skip_ingest: true,
      precompact_verified: true, operation_id: "omp-operation-1",
    }));
    const observations = new EventsDb(eventsDbPath(cwd, paths));
    try {
      expect(observations.getHookObservationSummary("omp-precompact")).toMatchObject([
        { harness: "omp", hook: "session_before_compact", operation: "summary",
          status: "skipped", reason: "disabled", count: 1 },
      ]);
    } finally {
      observations.close();
    }
  });

  it("skips a verified OMP summary while another project request occupies the queue", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-omp-busy-"));
    dirs.push(cwd);
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const queued = enqueue(projectId(cwd), async () => { entered.resolve(); await unblock.promise; });
    await entered.promise;
    const { res, getBody } = mockRes();
    const request = createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
      session_id: "omp-busy", cwd, client: "omp", skip_ingest: true,
      precompact_verified: true, operation_id: "omp-busy-operation",
    }));
    try {
      expect(await Promise.race([request.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(getBody().skipped).toBe(true);
      const observations = new EventsDb(eventsDbPath(cwd, paths));
      try {
        expect(observations.getHookObservationSummary("omp-busy")).toMatchObject([
          { harness: "omp", hook: "session_before_compact", operation: "summary",
            status: "skipped", reason: "busy", count: 1 },
        ]);
      } finally {
        observations.close();
      }
    } finally {
      unblock.resolve();
      await queued;
      await request;
    }
  });

  it("rechecks verified OMP admission after summarizer setup awaits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-precompact-omp-admission-"));
    dirs.push(cwd);
    const factoryEntered = Promise.withResolvers<void>();
    const factoryReady = Promise.withResolvers<any>();
    vi.mocked(createOpenAISummarizer).mockImplementationOnce(() => {
      factoryEntered.resolve();
      return factoryReady.promise as any;
    });
    const { res, getBody } = mockRes();
    const request = createCompactHandler(makeConfig("openai"), paths)({} as any, res, JSON.stringify({
      session_id: "omp-admission", cwd, client: "omp", skip_ingest: true,
      precompact_verified: true, operation_id: "omp-admission-operation",
    }));
    await factoryEntered.promise;
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    const queued = enqueue(projectId(cwd), async () => { entered.resolve(); await unblock.promise; });
    await entered.promise;
    factoryReady.resolve(async () => "summary");
    try {
      expect(await Promise.race([request.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]))
        .toBe(true);
      expect(getBody().skipped).toBe(true);
    } finally {
      unblock.resolve();
      await queued;
      await request;
    }
  });
});

async function readMessageCount(cwd: string, sessionId: string): Promise<number> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    return conversationStore.getMessageCount(conversation.conversationId);
  } finally {
    db.close();
  }
}

async function readMessageContents(cwd: string, sessionId: string): Promise<string[]> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    const messages = await conversationStore.getMessages(conversation.conversationId);
    return messages.map((m) => m.content);
  } finally {
    db.close();
  }
}

async function readSummaryCount(cwd: string, sessionId: string): Promise<number> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    return (await summaryStore.getSummariesByConversation(conversation.conversationId)).length;
  } finally {
    db.close();
  }
}

async function readContextMessageContents(cwd: string, sessionId: string): Promise<string[]> {
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  try {
    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    const items = await summaryStore.getContextItems(conversation.conversationId);
    const messages = await Promise.all(items.filter((item) => item.messageId !== null)
      .map((item) => conversationStore.getMessageById(item.messageId!)));
    return messages.flatMap((message) => message ? [message.content] : []);
  } finally {
    db.close();
  }
}

describe("buildCompactionMessage", () => {
  const base = {
    tokensBefore: 10_000, tokensAfter: 1_000,
    messageCount: 50, summaryCount: 3,
    maxDepth: 2, promotedCount: 0,
  };

  it("contains the header and closing motto", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("lossless-claude · compaction complete");
    expect(msg).toContain("Nothing was lost. Everything is remembered.");
  });

  it("calculates correct compression percentage (90% for 10x)", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("90.0% saved");
  });

  it("shows message and summary counts", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("messages  →  3 summaries");
    expect(msg).toContain("DAG layers deep");
  });

  it("shows promoted insight (singular) when promotedCount is 1", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 1 });
    expect(msg).toContain("insight promoted to long-term memory");
    expect(msg).not.toContain("insights promoted");
  });

  it("shows promoted insights (plural) when promotedCount > 1", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 3 });
    expect(msg).toContain("insights promoted to long-term memory");
  });

  it("omits promoted row when promotedCount is 0", () => {
    const msg = buildCompactionMessage({ ...base, promotedCount: 0 });
    expect(msg).not.toContain("promoted");
  });

  it("shows dash for ratio when tokensAfter is 0", () => {
    const msg = buildCompactionMessage({ ...base, tokensAfter: 0 });
    expect(msg).toContain("–");
  });

  it("bar is fully filled when all tokens are saved", () => {
    // tokensBefore > 0, tokensAfter = 0 → filled = 30, empty = 0
    const msg = buildCompactionMessage({ ...base, tokensAfter: 0 });
    expect(msg).toContain("█".repeat(30));
    expect(msg).not.toContain("░");
  });

  it("bar is fully empty when nothing is saved", () => {
    // tokensBefore === tokensAfter → saved = 0
    const msg = buildCompactionMessage({ ...base, tokensBefore: 1000, tokensAfter: 1000 });
    expect(msg).toContain("░".repeat(30));
    expect(msg).not.toContain("█");
  });

  it("formats token counts with K suffix for large numbers", () => {
    const msg = buildCompactionMessage({ ...base, tokensBefore: 50_000, tokensAfter: 5_000 });
    expect(msg).toContain("50.0K");
    expect(msg).toContain("5.0K");
  });

  it("border is 46 ━ characters wide", () => {
    const msg = buildCompactionMessage(base);
    expect(msg).toContain("━".repeat(46));
  });

  it("does not throw and clamps the bar when the context grew (tokensAfter > tokensBefore)", () => {
    expect(() => buildCompactionMessage({ ...base, tokensBefore: 1_000, tokensAfter: 2_000 })).not.toThrow();
    const msg = buildCompactionMessage({ ...base, tokensBefore: 1_000, tokensAfter: 2_000 });
    expect(msg).toContain("░".repeat(30));
    expect(msg).not.toContain("█");
    expect(msg).not.toContain("% saved");
    expect(msg).not.toContain("-100.0%");
    expect(msg).toContain("100.0% grew");
    expect(msg).toContain("2.0×  growth  ·  1.0K tokens added");
    expect(msg).not.toContain("compression");
  });

  it("labels growth from an empty baseline without a ratio or percentage", () => {
    const msg = buildCompactionMessage({ ...base, tokensBefore: 0, tokensAfter: 500 });
    expect(msg).toContain("░".repeat(30));
    expect(msg).toContain("  grew");
    expect(msg).toContain("–×  growth  ·  500 tokens added");
    expect(msg).not.toContain("% saved");
    expect(msg).not.toContain("compression");
  });
});

describe("createCompactHandler — summarizer branching", () => {
  // Use tmpdir() which always exists; these tests mock all summarizers and don't need unique project dirs
  const testCwd = tmpdir();

  it("uses createClaudeProcessSummarizer when provider is claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("claude-process"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createCodexProcessSummarizer when provider is codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("codex-process"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createCodexProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createAnthropicSummarizer when provider is anthropic", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("anthropic"), paths);
    // Trigger the handler to resolve the lazy import
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createAnthropicSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("uses createOpenAISummarizer when provider is openai", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createOpenAISummarizer).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model", baseURL: "http://localhost:11435/v1" })
    );
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it("passes llm.reasoning through to createOpenAISummarizer", async () => {
    vi.clearAllMocks();
    const config = makeConfig("openai");
    config.llm.reasoning = { effort: "minimal" };
    const handler = createCompactHandler(config, paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createOpenAISummarizer).toHaveBeenCalledWith(
      expect.objectContaining({ body: { reasoning: { effort: "minimal" } } })
    );
  });

  it("returns no-op when provider is 'disabled' — no summarizer created", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("disabled"), paths);
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
    expect(getBody().summary).toContain("disabled");
  });

  it("auto + client=claude resolves to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "claude" }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + client=codex resolves to codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    expect(createCodexProcessSummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createCopilotProcessSummarizer when provider is copilot-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("copilot-process"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));

    expect(createCopilotProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + client=copilot resolves to copilot-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "copilot" }));

    expect(createCopilotProcessSummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createOmpProcessSummarizer when provider is omp-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("omp-process"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));

    expect(createOmpProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + client=omp resolves to omp-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "omp" }));

    expect(createOmpProcessSummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + no client falls back to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("explicit provider ignores client override", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"), paths);
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    expect(createOpenAISummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("memoizes concrete providers across requests", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"), paths);
    const { res: res1 } = mockRes();
    const { res: res2 } = mockRes();

    await handler({} as any, res1, JSON.stringify({ session_id: "s1", cwd: testCwd, client: "codex" }));
    await handler({} as any, res2, JSON.stringify({ session_id: "s2", cwd: testCwd, client: "codex" }));

    expect(createCodexProcessSummarizer).toHaveBeenCalledTimes(1);
  });

  it("waits for project-language detection before choosing the first summary language", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-compact-language-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "lcm-compact-language-project-"));
    const scopedPaths = createLcmPaths(root);
    const transcriptPath = join(cwd, "session.jsonl");
    writeFileSync(
      transcriptPath,
      Array.from({ length: 20 }, (_, index) => JSON.stringify({
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Mensagem ${index}: ${"conteúdo suficiente para exigir compactação ".repeat(80)}`,
        },
      })).join("\n"),
    );

    vi.mocked(scheduleProjectLanguageDetection).mockImplementationOnce(async (detectedCwd, _db, _config, detectedPaths) => {
      await Promise.resolve();
      const metaPath = projectMetaPath(detectedCwd, detectedPaths);
      mkdirSync(dirname(metaPath), { recursive: true });
      writeFileSync(metaPath, JSON.stringify({ cwd: detectedCwd, language: "pt-BR" }));
    });
    const summarize = vi.fn().mockResolvedValue("resumo curto");
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(summarize);

    try {
      const handler = createCompactHandler(makeConfig("openai"), scopedPaths);
      const { res } = mockRes();
      await handler({} as any, res, JSON.stringify({ session_id: "first-summary-language", cwd, transcript_path: transcriptPath }));

      expect(scheduleProjectLanguageDetection).toHaveBeenCalledOnce();
      expect(summarize).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Boolean),
        expect.objectContaining({ language: "pt-BR" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not await detection when an explicit language already determines the summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-compact-explicit-language-"));
    const cwd = mkdtempSync(join(tmpdir(), "lcm-compact-explicit-project-"));
    const scopedPaths = createLcmPaths(root);
    const dbPath = projectDbPath(cwd, scopedPaths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("explicit-language");
    const messages = await store.createMessagesBulk(Array.from({ length: 20 }, (_, seq) => ({
      conversationId: conversation.conversationId,
      seq,
      role: (seq % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `mensagem ${seq} ${"conteúdo ".repeat(500)}`,
      tokenCount: 1_000,
    })));
    await new SummaryStore(db).appendContextMessages(conversation.conversationId, messages.map((message) => message.messageId));
    db.close();

    vi.mocked(scheduleProjectLanguageDetection).mockReturnValueOnce(new Promise(() => {}));
    const summarize = vi.fn().mockResolvedValue("summary");
    vi.mocked(createOpenAISummarizer).mockReturnValueOnce(summarize);
    const config = { ...makeConfig("openai"), summarizer: { mock: false, language: "en" } };

    try {
      const handler = createCompactHandler(config, scopedPaths);
      const { res } = mockRes();
      await handler({} as any, res, JSON.stringify({ session_id: "explicit-language", cwd, skip_ingest: true }));
      expect(summarize).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Boolean),
        expect.objectContaining({ language: "en" }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("POST /compact", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts compact request and returns summary", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, llm: { apiKey: "sk-test" } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: mkdtempSync(join(tmpdir(), "lossless-compact-proj-")), hook_event_name: "PreCompact" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(typeof body.summary).toBe("string");
  });

  it("reports no_work when the conversation has nothing to compact", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, llm: { apiKey: "sk-test" } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "empty-sess", cwd: mkdtempSync(join(tmpdir(), "lossless-compact-proj-")), skip_ingest: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replayOutcome).toBe("no_work");
  });

  it("skips transcript ingestion when skip_ingest is true", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-"));
    tempDirs.push(tempDir);

    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: "transcript user 1" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 1" } }),
        JSON.stringify({ message: { role: "user", content: "transcript user 2" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 2" } }),
        JSON.stringify({ message: { role: "user", content: "transcript user 3" } }),
        JSON.stringify({ message: { role: "assistant", content: "transcript assistant 3" } }),
      ].join("\n"),
    );

    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "openai", model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "skip-ingest-session";

    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: [
          { role: "user", content: "stored user 1", tokenCount: 3 },
          { role: "assistant", content: "stored assistant 1", tokenCount: 4 },
          { role: "user", content: "stored user 2", tokenCount: 3 },
          { role: "assistant", content: "stored assistant 2", tokenCount: 4 },
        ],
      }),
    });

    expect(ingestRes.status).toBe(200);
    expect(await ingestRes.json()).toMatchObject({ ingested: 4 });
    expect(await readMessageCount(tempDir, sessionId)).toBe(4);

    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        transcript_path: transcriptPath,
        skip_ingest: true,
      }),
    });

    expect(compactRes.status).toBe(200);
    expect(await readMessageCount(tempDir, sessionId)).toBe(4);
  });

  it("accepts previous_summary and returns latestSummaryContent", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-prev-summary-"));
    tempDirs.push(tempDir);

    // Use mock summarizer so compact actually produces a summary
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      summarizer: { mock: true },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "prev-summary-session";

    // Ingest enough messages to trigger compaction
    const messages: Array<{ role: string; content: string; tokenCount: number }> = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: `msg ${i}`, tokenCount: 100 });
      messages.push({ role: "assistant", content: `resp ${i}`, tokenCount: 100 });
    }
    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: tempDir, messages }),
    });
    expect(ingestRes.status).toBe(200);

    // Compact with previous_summary — verify it doesn't reject and returns latestSummaryContent
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        previous_summary: "prior context from previous session",
      }),
    });

    expect(compactRes.status).toBe(200);
    const body = await compactRes.json();
    // Verify latestSummaryContent is returned (proves previous_summary was accepted and compact ran)
    expect(typeof body.latestSummaryContent).toBe("string");
    expect(body.latestSummaryContent.length).toBeGreaterThan(0);
  });

  it("returns latestSummaryContent when summary is created", async () => {
    // Setup: create a real daemon with mock summarizer so compact produces a real summary
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-latest-content-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      summarizer: { mock: true },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "latest-content-session";

    // Ingest a substantial amount of messages to trigger compaction
    const messageData: Array<{ role: string; content: string; tokenCount: number }> = [];
    for (let i = 1; i <= 100; i++) {
      messageData.push({ role: "user" as const, content: `user message ${i}`, tokenCount: 100 });
      messageData.push({ role: "assistant" as const, content: `assistant response ${i}`, tokenCount: 100 });
    }

    const ingestRes = await fetch(`${baseUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        messages: messageData,
      }),
    });
    expect(ingestRes.status).toBe(200);

    // Compact with sufficient data to trigger actual summarization
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
      }),
    });

    expect(compactRes.status).toBe(200);
    const body = await compactRes.json();

    // Mock summarizer guarantees a summary is created — assert unconditionally
    expect(typeof body.latestSummaryContent).toBe("string");
    expect(body.latestSummaryContent.length).toBeGreaterThan(0);
  });

  it("updates redaction_stats when transcript ingestion contains secrets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-redact-"));
    tempDirs.push(tempDir);

    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        // ghp_ + 36 alphanumeric chars → matches built-in GitHub token pattern
        JSON.stringify({ message: { role: "user", content: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA here" } }),
        JSON.stringify({ message: { role: "assistant", content: "noted" } }),
        JSON.stringify({ message: { role: "user", content: "ok" } }),
      ].join("\n"),
    );

    // createAnthropicSummarizer is mocked at the top of this file
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "anthropic", apiKey: "sk-test" },
    }));

    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "compact-redact-stats",
        cwd: tempDir,
        transcript_path: transcriptPath,
      }),
    });

    expect(res.status).toBe(200);

    const db = new DatabaseSync(projectDbPath(tempDir, paths));
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      // ghp_ token is matched by gitleaks github-pat pattern (gitleaks takes priority over native)
      expect(byCategory["gitleaks"]).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("a session first written by /compact matches one first written by /ingest (#503)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-first-"));
    tempDirs.push(tempDir);
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "anthropic", apiKey: "sk-test" },
    }));
    const port = daemon.address().port;

    // A subagent-shaped transcript: the sidecar carries the attribution, the
    // messages carry Structure. Neither route is told either one explicitly.
    const subagentsDir = join(tempDir, "parent-session", "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    const transcriptFor = (sessionId: string) => {
      const path = join(subagentsDir, `${sessionId}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ message: { role: "user", content: "<command-name>/model</command-name><command-args>opus</command-args>" } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "grilling" } }] } }),
      ].join("\n"));
      writeFileSync(join(subagentsDir, `${sessionId}.meta.json`), JSON.stringify({ agentType: "Explore", description: "look around" }));
      return path;
    };
    const post = (route: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    expect((await post("/compact", { session_id: "agent-compact-first", cwd: tempDir, transcript_path: transcriptFor("agent-compact-first") })).status).toBe(200);
    expect((await post("/ingest", { session_id: "agent-ingest-first", cwd: tempDir, transcript_path: transcriptFor("agent-ingest-first") })).status).toBe(200);

    const db = new DatabaseSync(projectDbPath(tempDir, paths));
    try {
      const snapshot = (sessionId: string) => ({
        attribution: db.prepare("SELECT parent_session_id, subagent_type, subagent_desc FROM conversations WHERE session_id = ?").get(sessionId),
        parts: db.prepare(
          `SELECT m.seq, part_type, tool_name, tool_input FROM message_parts mp
           JOIN messages m ON m.message_id = mp.message_id
           JOIN conversations c ON c.conversation_id = m.conversation_id
           WHERE c.session_id = ? ORDER BY m.seq, ordinal`,
        ).all(sessionId),
      });
      const viaCompact = snapshot("agent-compact-first");
      expect(viaCompact.attribution).toEqual({ parent_session_id: "parent-session", subagent_type: "Explore", subagent_desc: "look around" });
      expect(viaCompact.parts).toEqual([
        { seq: 0, part_type: "command", tool_name: "/model", tool_input: "opus" },
        { seq: 1, part_type: "skill", tool_name: "grilling", tool_input: null },
      ]);
      expect(snapshot("agent-ingest-first")).toEqual(viaCompact);
    } finally {
      db.close();
    }
  });
});

describe("POST /compact with disabled provider", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns early with message when provider is disabled", async () => {
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config);
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: mkdtempSync(join(tmpdir(), "lossless-disabled-proj-")) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("disabled");
  });
});

describe("POST /compact — scrub redaction during transcript ingestion", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive patterns from transcript messages during compaction", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-scrub-"));
    tempDirs.push(tempDir);

    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const transcriptPath = join(tempDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ message: { role: "user", content: `my key is ${secret}` } }),
        JSON.stringify({ message: { role: "assistant", content: "I see your key" } }),
        JSON.stringify({ message: { role: "user", content: "thanks" } }),
        JSON.stringify({ message: { role: "assistant", content: "you're welcome" } }),
      ].join("\n"),
    );

    // Create daemon with sensitivePatterns configured (built-in patterns already cover sk-ant-*)
    daemon = await createDaemon(loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "openai", model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
      security: { sensitivePatterns: [] },
    }));

    const baseUrl = `http://127.0.0.1:${daemon.address().port}`;
    const sessionId = "scrub-compact-session";

    // Compact with transcript (not skip_ingest) — scrubber should redact the secret
    const compactRes = await fetch(`${baseUrl}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        transcript_path: transcriptPath,
      }),
    });

    expect(compactRes.status).toBe(200);

    // Verify messages were ingested
    const msgCount = await readMessageCount(tempDir, sessionId);
    expect(msgCount).toBe(4);

    // Verify the secret was redacted in stored message content
    const contents = await readMessageContents(tempDir, sessionId);
    const userMsg = contents[0];
    expect(userMsg).toContain("[REDACTED]");
    expect(userMsg).not.toContain(secret);

    // Verify redaction_stats table was updated
    const db = new DatabaseSync(projectDbPath(tempDir, paths));
    try {
      runLcmMigrations(db);
      const pid = projectId(tempDir);
      const row = db.prepare(
        "SELECT count FROM redaction_stats WHERE project_id = ? AND category = 'built_in'",
      ).get(pid) as { count: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.count).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("POST /compact — Codex transcript capture (#505)", () => {
  let daemon: DaemonInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const codexMessage = (role: "user" | "assistant", text: string) => JSON.stringify({
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });

  it("ingests the delta of a Codex session through the same adapter /ingest reads with", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-codex-"));
    tempDirs.push(tempDir);
    const sessionId = "codex-compact-session";
    const transcriptPath = join(tempDir, "rollout.jsonl");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: tempDir } });
    writeFileSync(transcriptPath, `${meta}\n${codexMessage("user", "first")}\n${codexMessage("assistant", "second")}\n`);

    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, summarizer: { mock: true } }));
    const post = (route: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${daemon!.address().port}${route}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    const ingested = await post("/ingest", { session_id: sessionId, cwd: tempDir, client: "codex", transcript_path: transcriptPath });
    expect(await ingested.json()).toMatchObject({ ingested: 2 });

    appendFileSync(transcriptPath, `${codexMessage("user", "third, after the last /ingest")}\n`);
    const compacted = await post("/compact", { session_id: sessionId, cwd: tempDir, client: "codex", transcript_path: transcriptPath });
    expect(compacted.status, await compacted.clone().text()).toBe(200);
    expect(await readMessageContents(tempDir, sessionId)).toEqual(["first", "second", "third, after the last /ingest"]);

    // The cursor /compact advanced is the one the next /ingest resumes from.
    appendFileSync(transcriptPath, `${codexMessage("assistant", "fourth")}\n`);
    const resumed = await post("/ingest", { session_id: sessionId, cwd: tempDir, client: "codex", transcript_path: transcriptPath });
    expect(await resumed.json()).toMatchObject({ ingested: 1 });
    expect(await readMessageContents(tempDir, sessionId)).toHaveLength(4);
  });

  it("answers 400 for a Codex transcript that names another project instead of silently reading nothing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-compact-codex-mismatch-"));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, "rollout.jsonl");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "codex-other", cwd: join(tempDir, "elsewhere") } });
    writeFileSync(transcriptPath, `${meta}\n${codexMessage("user", "first")}\n`);

    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, summarizer: { mock: true } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "codex-other", cwd: tempDir, client: "codex", transcript_path: transcriptPath }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Codex transcript cwd does not match requested project" });
  });
});

describe("replay restart during compaction", () => {
  it("waits for a same-session summary and leaves only the reset message context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lcm-replay-restart-"));
    const sessionId = "replay-session";
    const config = makeConfig("openai");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const url = `http://127.0.0.1:${daemon.address().port}`;
    const client = new DaemonClient(url);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let compacting: Promise<unknown> | undefined;
    try {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `message ${i} ${"context ".repeat(100)}`,
        tokenCount: 200,
      }));
      await client.post("/ingest", { cwd, session_id: sessionId, messages });
      createReplayRun({ cwd, paths, command: "import", runId: "restart-run", sessions: [{ sessionId }] });
      vi.mocked(createOpenAISummarizer).mockReturnValueOnce(async () => {
        entered.resolve();
        await release.promise;
        return "summary of interrupted compaction";
      });

      compacting = client.post("/compact", { cwd, session_id: sessionId, skip_ingest: true });
      await entered.promise;
      const resetting = clearReplayState({ cwd, paths, command: "import", client });
      expect(await Promise.race([resetting.then(() => "done"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50))]))
        .toBe("waiting");
      release.resolve();
      await compacting;
      expect(await resetting).toBe(true);
      expect(await readSummaryCount(cwd, sessionId)).toBe(0);
      expect(await readContextMessageContents(cwd, sessionId)).toEqual(messages.map((m) => m.content));
    } finally {
      release.resolve();
      await compacting;
      await daemon.stop();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(projectDir(cwd, paths), { recursive: true, force: true });
    }
  }, 10_000);
});
