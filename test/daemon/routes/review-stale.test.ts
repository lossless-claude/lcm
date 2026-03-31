import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { PromotedStore } from "../../../src/db/promoted.js";

describe("POST /review-stale", () => {
  let daemon: DaemonInstance | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-stale-test-"));
  });

  afterEach(async () => {
    if (daemon) { await daemon.stop(); daemon = undefined; }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function seedStaleMemory(dir: string, content: string, daysOld: number): string {
    const dbPath = projectDbPath(dir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content, tags: ["type:knowledge"], projectId: dir, confidence: 0.8 });
    // Backdate
    const oldDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000)
      .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    db.prepare(`UPDATE promoted SET created_at = ? WHERE content = ?`).run(oldDate, content);
    const row = db.prepare(`SELECT id FROM promoted WHERE content = ?`).get(content) as { id: string };
    db.close();
    return row.id;
  }

  it("returns 400 on invalid JSON body", async () => {
    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when cwd is missing", async () => {
    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("cwd is required");
  });

  it("returns empty stale list when no DB exists", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "no-db-"));
    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: emptyDir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { stale: unknown[]; total: number };
    expect(body.stale).toEqual([]);
    expect(body.total).toBe(0);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("lists stale candidates based on age", async () => {
    // staleAfterDays defaults to 90
    seedStaleMemory(tmpDir, "Old stale knowledge", 120);

    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { stale: Array<{ id: string; content: string; daysSinceCreated: number }>; total: number };
    expect(body.total).toBe(1);
    expect(body.stale[0].content).toBe("Old stale knowledge");
    expect(body.stale[0].daysSinceCreated).toBeGreaterThanOrEqual(119);
  });

  it("archives a stale candidate", async () => {
    const id = seedStaleMemory(tmpDir, "Archive me", 120);

    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const port = daemon.address().port;

    const archiveRes = await fetch(`http://127.0.0.1:${port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir, action: "archive", target_id: id }),
    });
    expect(archiveRes.status).toBe(200);
    const archiveBody = await archiveRes.json() as { action: string; id: string };
    expect(archiveBody.action).toBe("archived");

    // Should no longer appear in stale list
    const listRes = await fetch(`http://127.0.0.1:${port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir }),
    });
    const listBody = await listRes.json() as { total: number };
    expect(listBody.total).toBe(0);
  });

  it("revives an archived candidate", async () => {
    const id = seedStaleMemory(tmpDir, "Revive me", 120);

    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const port = daemon.address().port;

    // Archive first
    await fetch(`http://127.0.0.1:${port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir, action: "archive", target_id: id }),
    });

    // Revive
    const reviveRes = await fetch(`http://127.0.0.1:${port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir, action: "revive", target_id: id }),
    });
    expect(reviveRes.status).toBe(200);
    const reviveBody = await reviveRes.json() as { action: string };
    expect(reviveBody.action).toBe("revived");
  });

  it("returns 404 for unknown target_id", async () => {
    // Ensure DB exists
    seedStaleMemory(tmpDir, "Some memory", 120);

    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir, action: "archive", target_id: "nonexistent-id" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not found");
  });

  it("returns 400 for unknown action", async () => {
    const id = seedStaleMemory(tmpDir, "Bad action target", 120);

    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/review-stale`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: tmpDir, action: "delete", target_id: id }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unknown action");
  });
});
