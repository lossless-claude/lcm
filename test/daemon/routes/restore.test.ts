import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { getLcmConnection, closeLcmConnection, getPoolStats } from "../../../src/db/connection.js";
import { justCompactedMap } from "../../../src/daemon/routes/compact.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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
    // Use an isolated dir — shared tmpdir() gets session_instructions written by the
    // "first-ever session" test (non-compact path captures ~/.claude/CLAUDE.md), causing
    // this compact-restore assertion to fail due to test-order contamination.
    const isolatedDir = mkdtempSync(join(tmpdir(), "restore-compact-test-"));
    try {
      daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "s1", cwd: isolatedDir, source: "compact", hook_event_name: "SessionStart" }),
      });
      const body = await res.json();
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).not.toContain("<recent-session-context>");
      expect(body.context).not.toContain("<project-instructions>");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
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

    it.each(["startup", "resume", "clear"])("does not echo saved project-instructions on %s, but still replays them post-compact", async (source) => {
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Rules\nPrefer tabs over spaces.", "utf8");

      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const port = daemon.address().port;

      // Seed the snapshot first: an empty DB cannot expose the old startup echo.
      const seedRes = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "seed-instructions", cwd: tmpDir, source: "startup", hook_event_name: "SessionStart" }),
      });
      expect(seedRes.status).toBe(200);
      await seedRes.json();

      // The saved instructions must not duplicate the harness's own copy.
      const restoreRes = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "restore-no-echo", cwd: tmpDir, source, hook_event_name: "SessionStart" }),
      });
      expect(restoreRes.status).toBe(200);
      const restoreBody = await restoreRes.json();
      expect(restoreBody.context).not.toContain("<project-instructions>");
      expect(restoreBody.context).not.toContain("Prefer tabs over spaces.");

      // ...but the snapshot was still captured, so a later compaction can replay it.
      const compactRes = await fetch(`http://127.0.0.1:${port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "restore-no-echo", cwd: tmpDir, source: "compact", hook_event_name: "SessionStart" }),
      });
      expect(compactRes.status).toBe(200);
      const compactBody = await compactRes.json();
      expect(compactBody.context).toContain("<project-instructions>");
      expect(compactBody.context).toContain("Prefer tabs over spaces.");
    });

    it.each(["startup", "resume", "clear", undefined])("honors source %s when a recent compaction marker exists", async (source) => {
      const sessionId = `recent-compact-${source ?? "missing"}`;
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Saved instructions.", "utf8");
      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const url = `http://127.0.0.1:${daemon.address().port}/restore`;
      const seedRes = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, cwd: tmpDir, source: "startup" }),
      });
      expect(seedRes.status).toBe(200);
      await seedRes.json();
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Updated instructions.", "utf8");

      justCompactedMap.set(sessionId, Date.now());
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, cwd: tmpDir, source }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        if (source === undefined) {
          expect(body.context).toContain("<project-instructions>");
          expect(body.context).toContain("Saved instructions.");
        } else {
          expect(body.context).not.toContain("<project-instructions>");
        }

        // Explicit non-compact sources still refresh the snapshot; fallback only replays it.
        const compactRes = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, cwd: tmpDir, source: "compact" }),
        });
        expect(compactRes.status).toBe(200);
        const compactBody = await compactRes.json();
        expect(compactBody.context).toContain(source === undefined ? "Saved instructions." : "Updated instructions.");
      } finally {
        justCompactedMap.delete(sessionId);
      }
    });

    it("releases restore connection references without closing another caller's connection", async () => {
      const dbPath = projectDbPath(realpathSync(tmpDir));
      const db = getLcmConnection(dbPath);
      try {
        daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
        for (const source of ["startup", "compact"]) {
          const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: "shared-connection", cwd: tmpDir, source, hook_event_name: "SessionStart" }),
          });
          expect(res.status).toBe(200);
          await res.json();
          expect(getPoolStats().connections.find((entry) => entry.path === dbPath)?.refs).toBe(1);
          expect(db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
        }
      } finally {
        closeLcmConnection(dbPath);
      }
      expect(getPoolStats().connections.some((entry) => entry.path === dbPath)).toBe(false);
    });

    it("captures a CLAUDE.md reachable by two paths only once (cwd === $HOME)", async () => {
      // Point homedir() at tmpDir to model running Claude with cwd === $HOME. Then
      // `~/.claude/CLAUDE.md` and `${cwd}/.claude/CLAUDE.md` are the same file.
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      vi.mocked(homedir).mockReturnValue(tmpDir);
      try {
        mkdirSync(join(tmpDir, ".claude"), { recursive: true });
        writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "Only once please.", "utf8");

        daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
        const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "home-is-cwd", cwd: tmpDir, source: "startup", hook_event_name: "SessionStart" }),
        });
        expect(res.status).toBe(200);

        const dbPath = projectDbPath(tmpDir);
        const db = getLcmConnection(dbPath);
        try {
          const row = db.prepare(`SELECT content FROM session_instructions WHERE id = 1`).get() as
            | { content: string }
            | undefined;
          expect(row).toBeDefined();
          expect(row!.content.split("Only once please.").length - 1).toBe(1);
        } finally {
          closeLcmConnection(dbPath);
        }
      } finally {
        vi.mocked(homedir).mockImplementation(actual.homedir);
      }
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
        tags: ["source:passive-capture", "type:pattern"],
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

  describe("promoted age filtering", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "restore-age-test-"));
    });

    afterEach(() => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("excludes promoted memories older than restoreMaxPromotedAgeDays", async () => {
      const dbPath = projectDbPath(tmpDir);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      // Insert a recent memory
      store.insert({
        content: "Recent project knowledge that should surface",
        tags: ["type:knowledge"],
        projectId: tmpDir,
        confidence: 0.9,
      });

      // Insert an old memory by backdating created_at
      store.insert({
        content: "Ancient project knowledge that should be filtered",
        tags: ["type:knowledge"],
        projectId: tmpDir,
        confidence: 0.9,
      });
      // Backdate the second entry to 200 days ago
      const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
        .toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
      db.prepare(
        `UPDATE promoted SET created_at = ? WHERE content LIKE '%Ancient%'`
      ).run(oldDate);
      db.close();

      // Use restoreMaxPromotedAgeDays = 180 (default)
      daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
      const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "age-test", cwd: tmpDir, hook_event_name: "SessionStart" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { context: string };

      // Recent memory should be present, old one filtered out
      expect(body.context).toContain("Recent project knowledge");
      expect(body.context).not.toContain("Ancient project knowledge");
    });
  });
});
