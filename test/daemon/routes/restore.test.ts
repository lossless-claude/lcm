import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { PromotedStore } from "../../../src/db/promoted.js";

describe("POST /restore", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns empty context for first-ever session (orientation now lives in ~/.claude/lcm.md)", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "new-sess", cwd: tmpdir(), hook_event_name: "SessionStart" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).not.toContain("<memory-orientation>");
    expect(body.context).not.toContain("<recent-session-context>");
  });

  it("returns empty context for source=compact with no session_instructions", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", cwd: tmpdir(), source: "compact", hook_event_name: "SessionStart" }),
    });
    const body = await res.json();
    expect(body.context).not.toContain("<memory-orientation>");
    expect(body.context).not.toContain("<recent-session-context>");
    expect(body.context).not.toContain("<project-instructions>");
  });

  describe("session_instructions persistence", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("injects session_instructions on compact restore", async () => {
      // Pre-populate DB with session_instructions row
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      db.prepare(
        `INSERT INTO session_instructions (id, content, content_hash, updated_at)
         VALUES (1, ?, ?, datetime('now'))`,
      ).run("# ~/.claude/CLAUDE.md\nDo not use emojis.", "abc123hash");
      db.close();

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "compact-sess", cwd: tmpDir, source: "compact", hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).toContain("<project-instructions>");
      expect(body.context).toContain("Do not use emojis.");
      expect(body.context).not.toContain("<recent-session-context>");
    });

    it("captures CLAUDE.md on startup restore", async () => {
      // Write a CLAUDE.md into the temp project dir
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Rules\nAlways write tests.", "utf8");

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "startup-sess", cwd: tmpDir, source: "startup", hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");

      // Verify session_instructions was written to DB
      const dbPath = projectDbPath(tmpDir);
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(`SELECT content, content_hash FROM session_instructions WHERE id = 1`).get() as
        | { content: string; content_hash: string }
        | undefined;
      db.close();

      expect(row).toBeDefined();
      expect(row!.content).toContain("Always write tests.");
      expect(row!.content_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("does not re-upsert session_instructions when content hash unchanged", async () => {
      // Write CLAUDE.md
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Stable content.", "utf8");
      mkdirSync(join(tmpDir, ".lossless"), { recursive: true });

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const port = daemon.address().port;

      // First startup call
      await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-hash-1", cwd: tmpDir, source: "startup" }),
      });

      const dbPath = projectDbPath(tmpDir);
      const db1 = new DatabaseSync(dbPath);
      const row1 = db1.prepare(`SELECT updated_at FROM session_instructions WHERE id = 1`).get() as
        | { updated_at: string }
        | undefined;
      db1.close();
      expect(row1).toBeDefined();

      // Second startup call with identical content — updated_at should not change
      await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s-hash-2", cwd: tmpDir, source: "startup" }),
      });

      const db2 = new DatabaseSync(dbPath);
      const row2 = db2.prepare(`SELECT updated_at FROM session_instructions WHERE id = 1`).get() as
        | { updated_at: string }
        | undefined;
      db2.close();

      expect(row2).toBeDefined();
      expect(row2!.updated_at).toBe(row1!.updated_at);
    });
  });

  describe("passive-capture insights", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-insights-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("includes insights array when passive-capture entries exist in promoted store", async () => {
      // Pre-populate DB with promoted entries tagged source:passive-capture
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);
      store.insert({
        content: "Always prefer async/await over callbacks",
        tags: ["source:passive-capture", "category:pattern"],
        projectId: tmpDir,
        confidence: 0.75,
      });
      store.insert({
        content: "Use PromotedStore.search for cross-session queries",
        tags: ["source:passive-capture"],
        projectId: tmpDir,
        confidence: 0.5,
      });
      db.close();

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ins-sess", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> };
      expect(body.insights).toBeDefined();
      expect(body.insights!.length).toBeGreaterThan(0);
      expect(body.insights![0]).toHaveProperty("content");
      expect(body.insights![0]).toHaveProperty("confidence");
      expect(body.insights![0]).toHaveProperty("tags");
      // All returned insights should have source:passive-capture tag
      for (const insight of body.insights!) {
        expect(insight.tags).toContain("source:passive-capture");
      }
    });

    it("omits insights array when no passive-capture entries exist", async () => {
      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "no-ins-sess", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: unknown };
      expect(body.insights).toBeUndefined();
    });

    it("filters out insights below confidence 0.3", async () => {
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);
      store.insert({
        content: "Low confidence passive insight",
        tags: ["source:passive-capture"],
        projectId: tmpDir,
        confidence: 0.1,
      });
      db.close();

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "low-conf-sess", cwd: tmpDir }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string; insights?: unknown };
      expect(body.insights).toBeUndefined();
    });
  });
});
