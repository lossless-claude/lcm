import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath } from "../../../src/daemon/project.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /search", () => {
  it("rejects a requested backend that this native build does not provide", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/search`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "decision", backend: "unavailable" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Only native search is available in this build" });
    } finally { await daemon.stop(); }
  });

  it("finds promoted memories via FTS5", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-search-"));
    tempDirs.push(tempDir);

    // Pre-populate promoted table
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database is PostgreSQL", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { episodic: unknown[]; semantic: unknown[]; promoted: unknown[] };
      expect(res.status).toBe(200);
      expect(data.promoted.length).toBeGreaterThanOrEqual(1);
    } finally {
      await daemon.stop();
    }
  });

  it("returns all three layers in response", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-search-layers-"));
    tempDirs.push(tempDir);
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", cwd: tempDir }),
      });
      const data = await res.json() as Record<string, unknown>;
      expect(data).toHaveProperty("episodic");
      expect(data).toHaveProperty("promoted");
      // A clean query has no errors key — errors only appear on real failures.
      expect(data.errors).toBeUndefined();
    } finally {
      await daemon.stop();
    }
  });

  it("natural-language questions find episodic content (issue #309)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-search-nl-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const { ConversationStore } = await import("../../../src/store/conversation-store.js");
    const { SummaryStore } = await import("../../../src/store/summary-store.js");
    const convStore = new ConversationStore(db);
    const summStore = new SummaryStore(db);
    const conv = await convStore.createConversation({ sessionId: "sess-1" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 0,
      role: "user",
      content: "We rolled back the broken deploy and reverted the release.",
      tokenCount: 12,
    });
    await summStore.insertSummary({
      summaryId: "sum_1",
      conversationId: conv.conversationId,
      kind: "leaf",
      content: "We rolled back the broken deploy and reverted the release.",
      tokenCount: 12,
    });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      // None of the question's content words co-occur in the document under
      // AND semantics ("undo" never stems to "revert"); before the fix this
      // returned { episodic: [], promoted: [] }.
      const res = await fetch(`http://127.0.0.1:${port}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "how did we undo that broken release?", cwd: tempDir }),
      });
      const data = await res.json() as { episodic: unknown[]; promoted: unknown[] };
      expect(res.status).toBe(200);
      expect(data.episodic.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });
});
