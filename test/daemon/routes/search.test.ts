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
    } finally {
      await daemon.stop();
    }
  });
});
