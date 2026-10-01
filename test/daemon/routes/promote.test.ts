import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, vi } from "vitest";
import { projectId, projectDbPath } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { createPromoteHandler } from "../../../src/daemon/routes/promote.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { getPoolStats } from "../../../src/db/connection.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";

const paths = createLcmPaths(lcmHome());
const BACKLOG = 20;

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7, idleTimeoutMs: 1800000 },
    compaction: {
      autoCompactMinTokens: 10000,
      promotionThresholds: {
        minDepth: 1,
        compressionRatio: 0.1,
        keywords: { decision: ["decided", "agreed"], architecture: ["architecture", "pattern"] },
        architecturePatterns: [],
        dedupBm25Threshold: 15,
        dedupCandidateLimit: 3,
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

function setupDb(tempDir: string) {
  const dbPath = projectDbPath(tempDir, paths);
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
    const handler = createPromoteHandler(config, paths);
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
    const summaryId = `sum_${randomUUID()}`;
    await summStore.insertSummary({
      summaryId,
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
    const handler = createPromoteHandler(config, paths);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    const body = getBody();
    expect(body.processed).toBeGreaterThan(0);
    expect(body.promoted).toBeGreaterThan(0);
    const verifyDb = new DatabaseSync(projectDbPath(tempDir, paths));
    try {
      expect(new PromotedStore(verifyDb).getAll()).toEqual([
        expect.objectContaining({ source_summary_id: summaryId }),
      ]);
    } finally {
      verifyDb.close();
    }
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

    const handler = createPromoteHandler(config, paths);
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
    const handler = createPromoteHandler(config, paths);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir, dry_run: true }));

    const body = getBody();
    // Should report what would be promoted but not persist
    expect(body).toHaveProperty("processed");
    expect(body).toHaveProperty("promoted");
    // Verify promoted table is empty (nothing was written)
    const db2 = new DatabaseSync(projectDbPath(tempDir, paths));
    runLcmMigrations(db2);
    const rows = db2.prepare("SELECT COUNT(*) as count FROM promoted").get() as { count: number };
    db2.close();
    expect(rows.count).toBe(0);
  });

  async function seedPromotable(count: number): Promise<string> {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-promote-test-"));
    tempDirs.push(tempDir);
    const db = setupDb(tempDir);
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);
    const conv = await convStore.getOrCreateConversation("session-backlog");
    for (let i = 0; i < count; i++) {
      await summStore.insertSummary({
        summaryId: `sum_${randomUUID()}`,
        conversationId: conv.conversationId,
        kind: "leaf",
        content: `Topic ${i}: we decided to use store${i} for component${i}. This is an architecture decision.`,
        depth: 2,
        tokenCount: 50,
        sourceMessageTokenCount: 500,
        descendantCount: 5,
        descendantTokenCount: 450,
        earliestAt: new Date(),
        latestAt: new Date(),
      });
    }
    db.close();
    return tempDir;
  }

  it.each([false, true])("skips a promoted summary by id after its content prefix changes (dedup: %s)", async (dedup) => {
    const tempDir = await seedPromotable(1);
    const dbPath = projectDbPath(tempDir, paths);
    const db = new DatabaseSync(dbPath);
    const [summary] = await new SummaryStore(db).listRecent(1);
    if (dedup) {
      new PromotedStore(db).insert({
        content: summary.content,
        projectId: projectId(tempDir),
        sourceSummaryId: "sum_original",
      });
    }
    db.close();
    const config = makeConfig();
    if (dedup) config.compaction.promotionThresholds.dedupBm25Threshold = 0.000001;
    const handler = createPromoteHandler(config, paths);
    const first = mockRes();
    await handler({} as any, first.res, JSON.stringify({ cwd: tempDir }));
    expect(first.getBody().promoted).toBe(1);

    const changedDb = new DatabaseSync(dbPath);
    const before = changedDb.prepare("SELECT * FROM promoted ORDER BY rowid").all();
    expect(before).toHaveLength(dedup ? 2 : 1);
    expect(before).toContainEqual(expect.objectContaining({
      source_summary_id: summary.summaryId,
      archived_at: dedup ? expect.any(String) : null,
    }));
    changedDb.prepare("UPDATE summaries SET content = ? WHERE summary_id = ?").run(
      "Revised: we decided to change the architecture pattern after a new review.",
      summary.summaryId,
    );
    changedDb.close();
    const second = mockRes();
    await handler({} as any, second.res, JSON.stringify({ cwd: tempDir }));
    expect(second.getBody()).toMatchObject({ processed: 0, promoted: 0 });
    const verifyDb = new DatabaseSync(dbPath);
    try {
      expect(verifyDb.prepare("SELECT * FROM promoted ORDER BY rowid").all()).toEqual(before);
    } finally {
      verifyDb.close();
    }
  });

  it("skips a summary matching a legacy memory prefix without inserting or changing confidence", async () => {
    const tempDir = await seedPromotable(1);
    const dbPath = projectDbPath(tempDir, paths);
    const db = new DatabaseSync(dbPath);
    const [summary] = await new SummaryStore(db).listRecent(1);
    const content = `${summary.content} Additional architecture details for this summary.`;
    db.prepare("UPDATE summaries SET content = ? WHERE summary_id = ?").run(content, summary.summaryId);
    const store = new PromotedStore(db);
    const id = store.insert({
      content: `${content.slice(0, 100)} Legacy memory details.`,
      projectId: projectId(tempDir),
      confidence: 0.8,
    });
    expect(store.getById(id)?.source_summary_id).toBeNull();
    const before = db.prepare("SELECT * FROM promoted ORDER BY rowid").all();
    db.close();

    const config = makeConfig();
    config.compaction.promotionThresholds.dedupBm25Threshold = 0.000001;
    const { res, getBody } = mockRes();
    await createPromoteHandler(config, paths)({} as any, res, JSON.stringify({ cwd: tempDir }));
    const verifyDb = new DatabaseSync(dbPath);
    try {
      expect(new PromotedStore(verifyDb).count()).toBe(1);
      expect(new PromotedStore(verifyDb).getById(id)?.confidence).toBe(0.8);
      expect(verifyDb.prepare("SELECT * FROM promoted ORDER BY rowid").all()).toEqual(before);
      expect(getBody()).toMatchObject({ processed: 0, promoted: 0 });
    } finally {
      verifyDb.close();
    }
  });

  it("promotes a different summary even when a memory with provenance has the same content prefix", async () => {
    const tempDir = await seedPromotable(1);
    const db = new DatabaseSync(projectDbPath(tempDir, paths));
    const [summary] = await new SummaryStore(db).listRecent(1);
    new PromotedStore(db).insert({ content: summary.content, projectId: "p1", sourceSummaryId: "sum_other" });
    db.close();
    const { res, getBody } = mockRes();
    await createPromoteHandler(makeConfig(), paths)({} as any, res, JSON.stringify({ cwd: tempDir }));
    expect(getBody()).toMatchObject({ processed: 1, promoted: 1 });
  });

  it("lets the event loop run between summaries of a backlog", async () => {
    const tempDir = await seedPromotable(BACKLOG);
    const handler = createPromoteHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();

    let otherWorkRan = false;
    setImmediate(() => { otherWorkRan = true; });
    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    expect(getBody().promoted).toBe(BACKLOG);
    expect(otherWorkRan).toBe(true);
  });

  it("two concurrent runs for one project do not both promote the backlog", async () => {
    const tempDir = await seedPromotable(BACKLOG);
    const handler = createPromoteHandler(makeConfig(), paths);
    const first = mockRes();
    const second = mockRes();

    await Promise.all([
      handler({} as any, first.res, JSON.stringify({ cwd: tempDir })),
      handler({} as any, second.res, JSON.stringify({ cwd: tempDir })),
    ]);

    expect(first.getBody().promoted + second.getBody().promoted).toBe(BACKLOG);
    const db = new DatabaseSync(projectDbPath(tempDir, paths));
    const rows = db.prepare("SELECT COUNT(*) AS count FROM promoted").get() as { count: number };
    db.close();
    expect(rows.count).toBe(BACKLOG);
  });

  it("opens the project db through the shared pooled connection and releases it when done", async () => {
    const tempDir = await seedPromotable(1);
    const dbPath = projectDbPath(tempDir, paths);
    const handler = createPromoteHandler(makeConfig(), paths);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({ cwd: tempDir }));

    expect(getBody().promoted).toBe(1);
    // The pooled path applies WAL/foreign-key/busy-timeout setup that a standalone
    // `new DatabaseSync` does not; a leaked handle would also still show up here.
    expect(getPoolStats().connections.some((c) => c.path === dbPath)).toBe(false);

    const verifyDb = new DatabaseSync(dbPath);
    const mode = verifyDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    verifyDb.close();
    expect(mode.journal_mode).toBe("wal");
  });

  it("returns 400 when cwd is missing", async () => {
    const config = makeConfig();
    const handler = createPromoteHandler(config, paths);
    const { res, getBody } = mockRes();

    await handler({} as any, res, JSON.stringify({}));

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(getBody()).toHaveProperty("error");
  });
});
