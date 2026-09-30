import { describe, expect, it } from "vitest";
import { findUnsupportedDetails } from "../src/eval/unsupported-details.js";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { createLcmPaths } from "../src/lcm-paths.js";
import { projectDbPath, projectMetaPath } from "../src/daemon/project.js";
import { buildSyntheticSession } from "../test/bench/summarizer-eval-harness.js";
import { runSummarizerComparison } from "../src/eval/compare.js";
import { Command } from "commander";
import { registerEvalCommands } from "../src/cli/eval.js";
import { runEval } from "../src/eval/engine.js";
import { createOpenAISummarizer } from "../src/llm/openai.js";
import { createDaemon } from "../src/daemon/server.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { ensureAuthToken } from "../src/daemon/auth.js";
import { DaemonClient } from "../src/daemon/client.js";
import type { SummarizeJob } from "../src/daemon/summarize-jobs.js";
import { createProviderChain } from "../src/llm/provider-chain.js";

describe("unsupported summary details", () => {
  it("finds absent numbers, paths, identifiers and quoted strings without overlapping counts", () => {
    const source = 'Batch 42 uses src/ledger.ts and LedgerStore; the label is "ready".';
    const summary = 'Batch 42 uses src/ledger.ts and LedgerStore, then 7331 in src/missing.ts via MissingStore with "invented detail".';
    expect(findUnsupportedDetails(source, summary).map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "number", text: "7331" },
      { kind: "path", text: "src/missing.ts" },
      { kind: "identifier", text: "MissingStore" },
      { kind: "quoted", text: '"invented detail"' },
    ]);
    expect(findUnsupportedDetails("142 preLedgerStore", "42 LedgerStore").map((d) => d.text)).toEqual(["42", "LedgerStore"]);
  });

  it.each([
    "deep-dive", "end-to-end", "case-by-case", "Two-tier",
    "indexing/replay", "normal/post-compact", "daemon/database",
    "e.g. a guard", "i.e. one budget", "U.S. dates", "the file(s) touched", "moved into docs/design.",
  ])("ignores plain prose %s", (summary) => {
    expect(findUnsupportedDetails("A two-tier system.", summary)).toEqual([]);
  });

  it("matches a path at the end of a sentence without its full stop", () => {
    expect(findUnsupportedDetails("Edited src/present.ts today.", "Edited src/present.ts.")).toEqual([]);
    expect(findUnsupportedDetails("No matching details.", "Edited src/missing.ts.")).toEqual([
      { kind: "path", text: "src/missing.ts", start: 7, end: 21 },
    ]);
  });

  it.each([
    ["path", "/var/cache"], ["path", "./cache"], ["path", "../cache"],
    ["path", "~/cache"], ["path", "src/missing.ts"], ["path", "missing.json"],
    ["path", "cache_v2/entries"], ["path", "cache/entry42"],
    ["identifier", "snake_case"], ["identifier", "camelCase"],
    ["identifier", "store.close"], ["identifier", "close()"],
    ["identifier", "--no-planted"], ["number", "7331"],
    ["quoted", '"invented detail"'],
  ])("counts absent %s detail %s once with exact offsets", (kind, summary) => {
    const text = summary === "close()" ? "close" : summary;
    expect(findUnsupportedDetails("No matching details.", `Use ${summary} now.`)).toEqual([
      { kind, text, start: 4, end: 4 + text.length },
    ]);
    expect(findUnsupportedDetails(summary, summary)).toEqual([]);
  });

  it("keeps contractions separate from single-quoted details", () => {
    expect(findUnsupportedDetails("Use the existing label.", "Don't use 'invented detail'.").map((detail) => detail.text))
      .toEqual(["'invented detail'"]);
  });
});

describe("summarizer comparison", () => {
  it("keeps cost unknown when a priced rejected answer is retried without usage", async () => {
    let requests = 0;
    const adapter = createOpenAISummarizer({ model: "fake", _retryDelayMs: 0, _clientOverride: {
      chat: { completions: { create: async () => {
        const request = requests++;
        return {
          choices: [{ finish_reason: request === 0 ? "length" : "stop", message: {
            content: "Files: none\nA concise summary.\nExpand for details about: decisions",
          } }],
          ...(request === 1 ? {} : { usage: { prompt_tokens: 11, completion_tokens: 22, cost: 0.01 } }),
        };
      } } },
    } });
    const summarizer = createProviderChain([() => ({ name: "candidate", kind: "http", summarizer: async () => adapter })]);
    const result = await runEval({ session: buildSyntheticSession(), summarizer, model: "fake", provider: "openai", run: 1 });
    expect(result.incomplete).toBe(false);
    expect(result.totals.costUsd).toBeNull();
    expect(result.totals.maxTokensHits).toBe(1);
    expect(result.totals.rejectedCalls).toBe(1);
    expect(result.calls[0].attempts).toHaveLength(2);
    expect(result.calls[0].attempts.every((attempt) => attempt.latencyMs >= 0)).toBe(true);
  });

  it("rejects an unknown named endpoint through the CLI before opening any project database", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".eval-unknown-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ llm: { provider: "local", providers: {
      local: { type: "openai", model: "fake", baseURL: "http://127.0.0.1:1/v1", apiKey: "fake" },
    } } }));
    try {
      const program = new Command();
      registerEvalCommands(program, createLcmPaths(dir));
      await expect(program.parseAsync(["eval", "summarizer", "--session", "missing", "--models", "local,unknown",
        "--project", dir, "--no-planted", "--runs", "2"], { from: "user" })).rejects.toThrow('Unknown summarizer endpoint "unknown"');
      expect(readdirSync(dir).sort()).toEqual(["config.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs named endpoints sequentially and writes source-aligned reports without changing the project database", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".eval-test-"));
    const paths = createLcmPaths(join(dir, "memory"));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    const dbPath = projectDbPath(cwd, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("test-session");
    await store.createMessagesBulk(buildSyntheticSession().messages.map((message) => ({
      ...message, conversationId: conversation.conversationId,
    })));
    db.close();
    writeFileSync(projectMetaPath(cwd, paths), JSON.stringify({ language: "pt-BR" }));
    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;
    const seen: string[] = [];
    let cutOff = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body.model);
      expect(body.enable_thinking).toBe(false);
      expect(body.messages[0].content).toContain("pt-BR");
      const length = body.model === "unknown" && !cutOff;
      if (length) cutOff = true;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        model: body.model,
        choices: [{ finish_reason: length ? "length" : "stop", message: {
          content: 'Files: none\nKeep ristretto allocator ledger-writer.ts backfill verticality 7331 ULID; invented MissingStore. <script>alert("x")</script>\nExpand for details about: decisions',
        } }],
        usage: { prompt_tokens: 111, completion_tokens: length ? 8192 : 22, total_tokens: length ? 8303 : 133,
          ...(body.model === "priced" ? { cost: 0.01 } : {}),
        },
        timings: { prompt_ms: 12, predicted_ms: 34 },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fake endpoint address");
    const endpoint = (model: string) => ({ type: "openai", model, apiKey: "fake", baseURL: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 5000, maxConcurrent: 1, body: { enable_thinking: false } });
    writeFileSync(paths.configPath, JSON.stringify({ llm: { provider: "first", providers: {
      first: endpoint("priced"), second: endpoint("unknown"), fallback: endpoint("unused"),
    }, fallback: ["fallback"] }, summarizer: { mock: true } }));
    try {
      const result = await runSummarizerComparison({ cwd, paths, sessionId: "test-session", models: ["first", "second"], out: join(dir, "report") });
      const report = JSON.parse(readFileSync(result.jsonPath, "utf-8"));
      expect(report.results.map((run: { endpoint: string; label: string }) => [run.endpoint, run.label])).toEqual([
        ["first", "test-session"], ["first", "synthetic-planted"], ["second", "test-session"], ["second", "synthetic-planted"],
      ]);
      expect(seen).not.toContain("unused");
      expect(seen.slice(seen.indexOf("unknown")).every((model) => model === "unknown")).toBe(true);
      const first = report.results[0];
      expect(first.totals.inputTokens).toBe(first.totals.calls * 111);
      expect(first.totals.outputTokens).toBe(first.totals.calls * 22);
      expect(first.totals.costUsd).toBeCloseTo(first.totals.calls * 0.01);
      expect(first.totals.formatPass).toBe(first.totals.calls);
      expect(first.totals.unsupportedDetails).toBeGreaterThan(0);
      expect(first.calls[0]).toMatchObject({ source: expect.any(String), latencyMs: expect.any(Number), prefillMs: 12, decodeMs: 34 });
      expect(report.results[1].plantedFacts.every((fact: { survived: boolean }) => fact.survived)).toBe(true);
      expect(report.results[2].totals).toMatchObject({ costUsd: null, maxTokensHits: 1, rejectedCalls: 1 });
      expect(report.results[2].totals.inputTokens).toBe((report.results[2].totals.calls + 1) * 111);
      expect(report.chunks.length).toBeGreaterThanOrEqual(6);
      expect(report.chunks.every((chunk: { source: string; entries: Array<{ endpoint: string }> }) =>
        chunk.source.length > 0 && chunk.entries.map((entry) => entry.endpoint).join(",") === "first,second")).toBe(true);
      const html = readFileSync(result.htmlPath, "utf-8");
      expect(html).toContain("<details>");
      expect(html).toContain("<mark");
      expect(html).toContain("deterministic hint, not proof");
      expect(html).toContain("conversation content");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
      const onlyStored = await runSummarizerComparison({ cwd, paths, sessionId: "test-session", models: ["first"], runs: 2,
        planted: false, out: join(dir, "stored-only") });
      expect(onlyStored.report.results.map(({ label, run }) => [label, run])).toEqual([["test-session", 1], ["test-session", 2]]);
      expect(readFileSync(dbPath)).toEqual(before);
      expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});


describe("session-pool comparison through the daemon", () => {
  it.each([true, false])("worker available: %s; keeps project data read-only and continues endpoints", async (available) => {
    const dir = mkdtempSync(join(import.meta.dirname, ".eval-pool-"));
    const paths = createLcmPaths(join(dir, "memory"));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    const dbPath = projectDbPath(cwd, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("stored");
    await store.createMessagesBulk(buildSyntheticSession().messages.map((message) => ({
      ...message, conversationId: conversation.conversationId,
    })));
    db.close();
    const before = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;
    let endpointCalls = 0;
    const endpoint = createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      endpointCalls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
        content: "Files: none\nA concise summary.\nExpand for details about: decisions",
      } }], usage: { prompt_tokens: 10, completion_tokens: 12 } }));
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("missing fake endpoint");
    const config = loadDaemonConfig(paths.configPath, { daemon: { port: 0, idleTimeoutMs: 0 } });
    ensureAuthToken(paths.tokenPath);
    const daemon = await createDaemon(config, { paths, tokenPath: paths.tokenPath });
    const client = new DaemonClient(`http://127.0.0.1:${daemon.address().port}`, paths.tokenPath);
    const controller = new AbortController();
    const jobs: SummarizeJob[] = [];
    const worker = available ? (async () => {
      while (!controller.signal.aborted) {
        const result = await client.get<{ job?: SummarizeJob }>("/summarize-jobs/next?worker_id=fake", { signal: controller.signal });
        if (!result.job) continue;
        const job = result.job;
        jobs.push(job);
        await client.post(`/summarize-jobs/${job.id}`, {
          text: "Files: none\nKeep ristretto allocator ledger-writer.ts backfill verticality 7331 ULID.\nExpand for details about: decisions",
          providerId: "session-pool:sonnet", usage: { input_tokens: 33, output_tokens: 17, estimated: false },
          usageAttempts: [{ providerId: "session-pool:haiku", usage: { input_tokens: 2, output_tokens: 3, estimated: false }, failed: true }],
        });
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error; }) : Promise.resolve();
    writeFileSync(paths.configPath, JSON.stringify({ daemon: { port: daemon.address().port }, llm: {
      provider: "session-pool", providers: { local: { type: "openai", model: "fake", apiKey: "fake",
        baseURL: `http://127.0.0.1:${address.port}/v1` } }, fallback: ["local"],
    }, summarizer: { mock: true } }));
    try {
      await expect(new DaemonClient(`http://127.0.0.1:${daemon.address().port}`).post("/summarize-jobs/pool", {}))
        .rejects.toMatchObject({ status: 401 });
      const { report } = await runSummarizerComparison({ cwd, paths, sessionId: "stored",
        models: ["session-pool", "local"], planted: false, out: join(dir, "report") });
      const [pool, local] = report.results;
      expect(local.incomplete).toBe(false);
      expect(endpointCalls).toBe(local.totals.calls);
      if (available) {
        expect(pool.incomplete).toBe(false);
        expect(jobs.length).toBeGreaterThan(0);
        expect(jobs.every((job) => job.pool === true)).toBe(true);
        expect(pool.calls[0].usages).toMatchObject([
          { provider: "session-pool:haiku", model: "haiku", inputTokens: 2, outputTokens: 3, failed: true },
          { provider: "session-pool:sonnet", model: "sonnet", inputTokens: 33, outputTokens: 17 },
        ]);
        expect(pool.totals.inputTokens).toBe(pool.totals.calls * 35);
        expect(pool.totals.outputTokens).toBe(pool.totals.calls * 20);
        expect(pool.totals.costUsd).toBeNull();
        expect(pool.calls[0].source).toBeTruthy();
        expect(readFileSync(join(dir, "report", "report.html"), "utf-8").includes("session-pool:sonnet")).toBe(true);
      } else {
        expect(pool.incomplete).toBe(true);
        expect(pool.error).toContain("LCM_SUMMARIZE_WORKER=1");
        expect(pool.error).toContain("docs/summarize-workers.md");
        expect(pool.totals.calls).toBe(1);
      }
      expect(readFileSync(dbPath)).toEqual(before);
      expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
      await expect(runSummarizerComparison({ cwd, paths, sessionId: "stored", models: ["session"] }))
        .rejects.toThrow("session");
    } finally {
      controller.abort();
      await worker;
      await daemon.stop();
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("says how to start the daemon when it is not running", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, ".eval-pool-down-"));
    const paths = createLcmPaths(join(dir, "memory"));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    const dbPath = projectDbPath(cwd, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new ConversationStore(db);
    const conversation = await store.getOrCreateConversation("stored");
    await store.createMessagesBulk(buildSyntheticSession().messages.map((message) => ({
      ...message, conversationId: conversation.conversationId,
    })));
    db.close();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    writeFileSync(paths.configPath, JSON.stringify({ daemon: { port }, llm: { provider: "session-pool" }, summarizer: { mock: true } }));
    try {
      const { report } = await runSummarizerComparison({ cwd, paths, sessionId: "stored",
        models: ["session-pool"], planted: false, out: join(dir, "report") });
      expect(report.results[0].incomplete).toBe(true);
      expect(report.results[0].error).toContain(`lcm daemon is not running on port ${port}`);
      expect(report.results[0].error).toContain("lcm daemon start --detach");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
