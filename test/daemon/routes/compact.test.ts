import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";

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

import { createClaudeProcessSummarizer } from "../../../src/llm/claude-process.js";
import { createCodexProcessSummarizer } from "../../../src/llm/codex-process.js";
import { createAnthropicSummarizer } from "../../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../../src/llm/openai.js";
import { createCompactHandler, buildCompactionMessage } from "../../../src/daemon/routes/compact.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

function makeConfig(provider: DaemonConfig["llm"]["provider"]): Partial<DaemonConfig> {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
      promotionThresholds: { minDepth: 2, compressionRatio: 0.3, keywords: {}, architecturePatterns: [], dedupBm25Threshold: 15, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: { provider, model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
    security: { sensitivePatterns: [] },
    summarizer: { mock: false },
  };
}

async function readMessageCount(cwd: string, sessionId: string): Promise<number> {
  const db = new DatabaseSync(projectDbPath(cwd));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    return conversationStore.getMessageCount(conversation.conversationId);
  } finally {
    db.close();
  }
}

async function readMessageContents(cwd: string, sessionId: string): Promise<string[]> {
  const db = new DatabaseSync(projectDbPath(cwd));

  try {
    const conversationStore = new ConversationStore(db);
    const conversation = await conversationStore.getOrCreateConversation(sessionId);
    const messages = await conversationStore.getMessages(conversation.conversationId);
    return messages.map((m) => m.content);
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
});

describe("createCompactHandler — summarizer branching", () => {
  it("uses createClaudeProcessSummarizer when provider is claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("claude-process"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-claude-process" }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createCodexProcessSummarizer when provider is codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("codex-process"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-codex-process" }));
    expect(createCodexProcessSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("uses createAnthropicSummarizer when provider is anthropic", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("anthropic"));
    // Trigger the handler to resolve the lazy import
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-anthropic" }));
    expect(createAnthropicSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("uses createOpenAISummarizer when provider is openai", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-openai" }));
    expect(createOpenAISummarizer).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model", baseURL: "http://localhost:11435/v1" })
    );
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it("returns no-op when provider is 'disabled' — no summarizer created", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("disabled"));
    const { res, getBody } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-disabled" }));
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
    expect(getBody().summary).toContain("disabled");
  });

  it("auto + client=claude resolves to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-auto-claude", client: "claude" }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + client=codex resolves to codex-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-auto-codex", client: "codex" }));
    expect(createCodexProcessSummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
  });

  it("auto + no client falls back to claude-process", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-auto-default" }));
    expect(createClaudeProcessSummarizer).toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("explicit provider ignores client override", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("openai"));
    const { res } = mockRes();
    await handler({} as any, res, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-explicit-provider", client: "codex" }));
    expect(createOpenAISummarizer).toHaveBeenCalled();
    expect(createClaudeProcessSummarizer).not.toHaveBeenCalled();
    expect(createCodexProcessSummarizer).not.toHaveBeenCalled();
  });

  it("memoizes concrete providers across requests", async () => {
    vi.clearAllMocks();
    const handler = createCompactHandler(makeConfig("auto"));
    const { res: res1 } = mockRes();
    const { res: res2 } = mockRes();

    await handler({} as any, res1, JSON.stringify({ session_id: "s1", cwd: "/tmp/test-memoized", client: "codex" }));
    await handler({} as any, res2, JSON.stringify({ session_id: "s2", cwd: "/tmp/test-memoized", client: "codex" }));

    expect(createCodexProcessSummarizer).toHaveBeenCalledTimes(1);
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
      body: JSON.stringify({ session_id: "test-sess", cwd: "/tmp/test-compact-proj", hook_event_name: "PreCompact" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(typeof body.summary).toBe("string");
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

    const db = new DatabaseSync(projectDbPath(tempDir));
    try {
      const rows = db.prepare(
        "SELECT category, count FROM redaction_stats ORDER BY category"
      ).all() as Array<{ category: string; count: number }>;
      const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.count]));
      expect(byCategory["built_in"]).toBeGreaterThan(0);
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
      body: JSON.stringify({ session_id: "test-sess", cwd: "/tmp/test-disabled-proj" }),
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
    const db = new DatabaseSync(projectDbPath(tempDir));
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
