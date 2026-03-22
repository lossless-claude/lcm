import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import { projectDbPath } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      leafTokens: 1000, maxDepth: 5, autoCompactMinTokens: 10000,
      promotionThresholds: {
        minDepth: 1,
        compressionRatio: 0.1,
        keywords: { decision: ["decided", "agreed"], architecture: ["architecture", "pattern"] },
        architecturePatterns: [],
        dedupBm25Threshold: 15,
        mergeMaxEntries: 3,
        confidenceDecayRate: 0.1,
      },
    },
    restoration: { recentSummaries: 3, promptSearchMinScore: 10, promptSearchMaxResults: 3, promptSnippetLength: 200, recencyHalfLifeHours: 24, crossSessionAffinity: 0.5 },
    llm: { provider: "claude-process", model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    claudeCliProxy: { enabled: false, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
    security: { sensitivePatterns: [] },
  } as DaemonConfig;
}

function mockRes() {
  let body = "";
  const res = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn((data?: string) => { body = data ?? ""; }),
  } as any;
  return { res, getBody: () => JSON.parse(body || "{}") };
}

const mockSummarize = vi.fn(async (text: string) => `summarized: ${text.slice(0, 30)}`);

function setupDb(tempDir: string) {
  const dbPath = projectDbPath(tempDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("createPromoteHandler", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns { processed: 0, promoted: 0 } when no summaries exist", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-test-"));
    tempDirs.push(tempDir);

    const db = setupDb(tempDir);
    db.close();

    const config = makeConfig();
    const getSummarizer = async () => mockSummarize;
    const handler = createPromoteHandler(config, getSummarizer);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    const body = getBody();
    expect(body).toMatchObject({ processed: 0, promoted: 0 });
  });

  it("promotes a summary that matches keyword signals", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-test-"));
    tempDirs.push(tempDir);

    const db = setupDb(tempDir);
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);

    const conv = await convStore.getOrCreateConversation("session-promote-1");
    // Insert a summary with keyword signals that should promote
    await summStore.insertSummary({
      summaryId: `sum_${randomUUID()}`,
      conversationId: conv.conversationId,
      kind: "leaf",
      content: "We decided to use PostgreSQL for the main database. This is an architecture decision.",
      depth: 2,
      tokenCount: 50,
      sourceMessageTokenCount: 500,
      descendantCount: 5,
      descendantTokenCount: 450,
      earliestAt: new Date(),
      latestAt: new Date(),
    });
    db.close();

    const config = makeConfig();
    const getSummarizer = async () => mockSummarize;
    const handler = createPromoteHandler(config, getSummarizer);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    const body = getBody();
    expect(body.processed).toBeGreaterThan(0);
    expect(body.promoted).toBeGreaterThan(0);
  });

  it("skips low-signal summaries that do not meet thresholds", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-test-"));
    tempDirs.push(tempDir);

    const db = setupDb(tempDir);
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);

    const conv = await convStore.getOrCreateConversation("session-low-signal");
    // Very shallow, no keywords, compression ratio too high (tokenCount close to source)
    await summStore.insertSummary({
      summaryId: `sum_${randomUUID()}`,
      conversationId: conv.conversationId,
      kind: "leaf",
      content: "Some random chat text without any keywords.",
      depth: 1,
      tokenCount: 95,
      sourceMessageTokenCount: 100,  // 95% ratio — above compressionRatio threshold of 0.1 means NOT compressed enough
      descendantCount: 1,
      descendantTokenCount: 90,
      earliestAt: new Date(),
      latestAt: new Date(),
    });
    db.close();

    const config = makeConfig();
    // Override thresholds to make it harder to promote
    config.compaction.promotionThresholds.minDepth = 3;
    config.compaction.promotionThresholds.compressionRatio = 0.1;
    config.compaction.promotionThresholds.keywords = {};
    config.compaction.promotionThresholds.architecturePatterns = [];

    const getSummarizer = async () => mockSummarize;
    const handler = createPromoteHandler(config, getSummarizer);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    const body = getBody();
    expect(body.processed).toBeGreaterThan(0);
    expect(body.promoted).toBe(0);
  });

  it("respects dry_run flag — does not write to DB when dry_run is true", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-test-"));
    tempDirs.push(tempDir);

    const db = setupDb(tempDir);
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);

    const conv = await convStore.getOrCreateConversation("session-dry-run");
    await summStore.insertSummary({
      summaryId: `sum_${randomUUID()}`,
      conversationId: conv.conversationId,
      kind: "leaf",
      content: "We decided to use PostgreSQL for the main database. This is an architecture decision.",
      depth: 2,
      tokenCount: 50,
      sourceMessageTokenCount: 500,
      descendantCount: 5,
      descendantTokenCount: 450,
      earliestAt: new Date(),
      latestAt: new Date(),
    });
    db.close();

    const config = makeConfig();
    const getSummarizer = async () => mockSummarize;
    const handler = createPromoteHandler(config, getSummarizer);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir, dry_run: true }));

    const body = getBody();
    // Should report what would be promoted but not persist
    expect(body).toHaveProperty("processed");
    expect(body).toHaveProperty("promoted");
    // Verify promoted table is empty (nothing was written)
    const db2 = new DatabaseSync(projectDbPath(tempDir));
    runLcmMigrations(db2);
    const rows = db2.prepare("SELECT COUNT(*) as count FROM promoted").get() as { count: number };
    db2.close();
    expect(rows.count).toBe(0);
  });

  it("returns 400 when cwd is missing", async () => {
    const config = makeConfig();
    const getSummarizer = async () => mockSummarize;
    const handler = createPromoteHandler(config, getSummarizer);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({}));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody()).toHaveProperty("error");
  });
});
