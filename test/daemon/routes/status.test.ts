import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { ConversationStore } from "../../../src/store/conversation-store.js";
import { SummaryStore } from "../../../src/store/summary-store.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath, projectMetaPath, ensureProjectDir } from "../../../src/daemon/project.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /status", () => {
  let daemon: DaemonInstance | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
  });

  it("returns correct stats for project with data", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-status-"));
    tempDirs.push(tempDir);

    // Pre-populate database with messages, summaries, and promoted
    const dbPath = projectDbPath(tempDir);
    ensureProjectDir(tempDir);
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const promotedStore = new PromotedStore(db);

    // Create a conversation and add messages
    const conversation = await conversationStore.getOrCreateConversation("test-session-1");
    await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Hello",
        tokenCount: 5,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Hi there",
        tokenCount: 3,
      },
    ]);

    // Add a summary
    await summaryStore.insertSummary({
      summaryId: "sum_test_1",
      conversationId: conversation.conversationId,
      kind: "condensed",
      content: "User greeted assistant",
      tokenCount: 10,
      sourceMessageTokenCount: 8,
    });

    // Add a promoted memory
    promotedStore.insert({
      content: "Important insight from conversation",
      tags: ["decision"],
      projectId: "test-project",
    });

    db.close();

    // Write meta.json with timestamps
    const metaPath = projectMetaPath(tempDir);
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify({
        cwd: tempDir,
        lastIngest: "2026-03-22T10:00:00.000Z",
        lastCompact: "2026-03-22T09:00:00.000Z",
        lastPromote: "2026-03-22T08:00:00.000Z",
      }),
    );

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempDir }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Check daemon info
    expect(data.daemon).toBeDefined();
    expect(data.daemon.version).toBeDefined();
    expect(typeof data.daemon.uptime).toBe("number");
    expect(data.daemon.uptime).toBeGreaterThanOrEqual(0);
    expect(data.daemon.port).toBe(daemon.address().port);

    // Check project stats
    expect(data.project).toBeDefined();
    expect(data.project.messageCount).toBe(2);
    expect(data.project.summaryCount).toBe(1);
    expect(data.project.promotedCount).toBe(1);

    // Check timestamps
    expect(data.project.lastIngest).toBe("2026-03-22T10:00:00.000Z");
    expect(data.project.lastCompact).toBe("2026-03-22T09:00:00.000Z");
    expect(data.project.lastPromote).toBe("2026-03-22T08:00:00.000Z");
  });

  it("returns zeros for empty project", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-status-empty-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempDir }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Check daemon info is present
    expect(data.daemon).toBeDefined();
    expect(data.daemon.version).toBeDefined();

    // Check project stats are zeros
    expect(data.project.messageCount).toBe(0);
    expect(data.project.summaryCount).toBe(0);
    expect(data.project.promotedCount).toBe(0);

    // Check timestamps are null
    expect(data.project.lastIngest).toBeNull();
    expect(data.project.lastCompact).toBeNull();
    expect(data.project.lastPromote).toBeNull();
  });

  it("includes daemon version and uptime", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-status-version-"));
    tempDirs.push(tempDir);

    daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tempDir }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Check version format (e.g., "0.1.0" or "0.0.0")
    expect(data.daemon.version).toMatch(/^\d+\.\d+\.\d+$/);

    // Check uptime is a non-negative number in seconds
    expect(typeof data.daemon.uptime).toBe("number");
    expect(data.daemon.uptime).toBeGreaterThanOrEqual(0);

    // Check port is present
    expect(typeof data.daemon.port).toBe("number");
    expect(data.daemon.port).toBeGreaterThan(0);
  });
});
