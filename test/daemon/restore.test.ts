import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { projectDbPath } from "../../src/daemon/project.js";
import { createRestore, type Insight, type Restore, type RestoreRequest } from "../../src/daemon/restore/index.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { closeLcmConnection, getLcmConnection, getPoolStats } from "../../src/db/connection.js";
import { markSessionCompacted } from "../../src/db/session-compactions.js";

const paths = createLcmPaths(lcmHome());

/** Repointed by the one test that models cwd === $HOME; every other test reads the real home. */
const homeOverride = vi.hoisted(() => ({ dir: undefined as string | undefined }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => homeOverride.dir ?? actual.homedir() };
});

/** The context of a restore that must have one; anything else is reported by its own message. */
async function assemble(restore: Restore, request: RestoreRequest): Promise<{ context: string; insights?: readonly Insight[] }> {
  const outcome = await restore(request);
  if (outcome.kind !== "context") throw new Error(`restore ${outcome.kind}: ${outcome.message}`);
  return outcome;
}

function restoreFor(projectDir: string, overrides?: Record<string, unknown>): Restore {
  return createRestore(loadDaemonConfig(projectDir, { daemon: { port: 0 }, ...overrides }), paths);
}

describe("restore (Claude Code)", () => {
  it("returns empty context for first-ever session (orientation now lives in ~/.claude/lcm.md)", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "restore-first-session-"));
    try {
      const body = await assemble(restoreFor(isolatedDir), { sessionId: "new-sess", cwd: isolatedDir });
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).not.toContain("<recent-session-context>");
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it("returns empty context for source=compact with no session_instructions", async () => {
    // Each fixture needs its own project database and instruction snapshot.
    const isolatedDir = mkdtempSync(join(tmpdir(), "restore-compact-test-"));
    try {
      const body = await assemble(restoreFor("/x"), { sessionId: "s1", cwd: isolatedDir, source: "compact" });
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).not.toContain("<recent-session-context>");
      expect(body.context).not.toContain("<project-instructions>");
      expect(body.insights).toBeUndefined();
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it("keeps capturing the snapshot when session_id is not a string", async () => {
    // A non-string id can match no conversation, but binding one used to throw inside the
    // block that also refreshes the snapshot, dropping all of it without a trace.
    const isolatedDir = mkdtempSync(join(tmpdir(), "restore-bad-session-id-"));
    try {
      writeFileSync(join(isolatedDir, "CLAUDE.md"), "Project rule.", "utf8");
      await assemble(restoreFor("/x"), { sessionId: { not: "a string" }, cwd: isolatedDir, source: "startup" });

      const dbPath = projectDbPath(realpathSync(isolatedDir), paths);
      const db = getLcmConnection(dbPath);
      try {
        const row = db.prepare("SELECT content FROM session_instructions WHERE id = 1")
          .get() as { content: string } | undefined;
        expect(row?.content).toContain("Project rule.");
      } finally {
        closeLcmConnection(dbPath);
      }
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
      const dbPath = projectDbPath(tmpDir, paths);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      db.prepare(
        `INSERT INTO session_instructions (id, content, content_hash, updated_at)
         VALUES (1, ?, ?, datetime('now'))`,
      ).run("# ~/.claude/CLAUDE.md\nDo not use emojis.", "abc123hash");
      db.close();

      const body = await assemble(restoreFor(tmpDir), { sessionId: "compact-sess", cwd: tmpDir, source: "compact" });
      expect(body.context).not.toContain("<memory-orientation>");
      expect(body.context).toContain("<project-instructions>");
      expect(body.context).toContain("Do not use emojis.");
      expect(body.context).not.toContain("<recent-session-context>");
    });

    it("captures CLAUDE.md on startup restore", async () => {
      // Write a CLAUDE.md into the temp project dir
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project Rules\nAlways write tests.", "utf8");

      const body = await assemble(restoreFor(tmpDir), { sessionId: "startup-sess", cwd: tmpDir, source: "startup" });
      expect(body.context).not.toContain("<memory-orientation>");

      // Verify session_instructions was written to DB
      const dbPath = projectDbPath(tmpDir, paths);
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
      const restore = restoreFor(tmpDir);

      // Seed the snapshot first: an empty DB cannot expose the old startup echo.
      await assemble(restore, { sessionId: "seed-instructions", cwd: tmpDir, source: "startup" });

      // The saved instructions must not duplicate the harness's own copy.
      const restored = await assemble(restore, { sessionId: "restore-no-echo", cwd: tmpDir, source });
      expect(restored.context).not.toContain("<project-instructions>");
      expect(restored.context).not.toContain("Prefer tabs over spaces.");

      // ...but the snapshot was still captured, so a later compaction can replay it.
      const compacted = await assemble(restore, { sessionId: "restore-no-echo", cwd: tmpDir, source: "compact" });
      expect(compacted.context).toContain("<project-instructions>");
      expect(compacted.context).toContain("Prefer tabs over spaces.");
    });

    it.each(["startup", "resume", "clear", undefined])("honors source %s when a recent compaction marker exists", async (source) => {
      const sessionId = `recent-compact-${source ?? "missing"}`;
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Saved instructions.", "utf8");
      const restore = restoreFor(tmpDir);
      await assemble(restore, { sessionId, cwd: tmpDir, source: "startup" });
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Updated instructions.", "utf8");

      // The mark /compact leaves for the restore that follows it.
      const markDbPath = projectDbPath(realpathSync(tmpDir), paths);
      const markDb = getLcmConnection(markDbPath);
      try {
        runLcmMigrations(markDb);
        markSessionCompacted(markDb, sessionId);
      } finally {
        closeLcmConnection(markDbPath);
      }
      try {
        const body = await assemble(restore, { sessionId, cwd: tmpDir, source });
        if (source === undefined) {
          expect(body.context).toContain("<project-instructions>");
          expect(body.context).toContain("Saved instructions.");
        } else {
          expect(body.context).not.toContain("<project-instructions>");
        }

        // Explicit non-compact sources still refresh the snapshot; fallback only replays it.
        const compactBody = await assemble(restore, { sessionId, cwd: tmpDir, source: "compact" });
        expect(compactBody.context).toContain(source === undefined ? "Saved instructions." : "Updated instructions.");
      } finally {
        const cleanupDb = getLcmConnection(markDbPath);
        try {
          cleanupDb.prepare("DELETE FROM session_compactions WHERE session_id = ?").run(sessionId);
        } finally {
          closeLcmConnection(markDbPath);
        }
      }
    });

    it("releases restore connection references without closing another caller's connection", async () => {
      const dbPath = projectDbPath(realpathSync(tmpDir), paths);
      const db = getLcmConnection(dbPath);
      try {
        const restore = restoreFor(tmpDir);
        for (const source of ["startup", "compact"]) {
          await assemble(restore, { sessionId: "shared-connection", cwd: tmpDir, source });
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
      homeOverride.dir = tmpDir;
      try {
        mkdirSync(join(tmpDir, ".claude"), { recursive: true });
        writeFileSync(join(tmpDir, ".claude", "CLAUDE.md"), "Only once please.", "utf8");

        await assemble(restoreFor(tmpDir), { sessionId: "home-is-cwd", cwd: tmpDir, source: "startup" });

        const dbPath = projectDbPath(realpathSync(tmpDir), paths);
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
        homeOverride.dir = undefined;
      }
    });

    it("does not re-upsert session_instructions when content hash unchanged", async () => {
      // Write CLAUDE.md
      writeFileSync(join(tmpDir, "CLAUDE.md"), "Stable content.", "utf8");
      mkdirSync(join(tmpDir, ".lossless"), { recursive: true });
      const restore = restoreFor(tmpDir);

      // First startup call
      await assemble(restore, { sessionId: "s-hash-1", cwd: tmpDir, source: "startup" });

      const dbPath = projectDbPath(tmpDir, paths);
      const db1 = new DatabaseSync(dbPath);
      const row1 = db1.prepare(`SELECT updated_at FROM session_instructions WHERE id = 1`).get() as
        | { updated_at: string }
        | undefined;
      db1.close();
      expect(row1).toBeDefined();

      // Second startup call with identical content — updated_at should not change
      await assemble(restore, { sessionId: "s-hash-2", cwd: tmpDir, source: "startup" });

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
      const dbPath = projectDbPath(tmpDir, paths);
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

      const body = await assemble(restoreFor(tmpDir), { sessionId: "ins-sess", cwd: tmpDir });
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
      const body = await assemble(restoreFor(tmpDir), { sessionId: "no-ins-sess", cwd: tmpDir });
      expect(body.insights).toBeUndefined();
    });

    it("filters out insights below confidence 0.3", async () => {
      const dbPath = projectDbPath(tmpDir, paths);
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

      const body = await assemble(restoreFor(tmpDir), { sessionId: "low-conf-sess", cwd: tmpDir });
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
      const dbPath = projectDbPath(tmpDir, paths);
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
      const body = await assemble(restoreFor(tmpDir), { sessionId: "age-test", cwd: tmpDir });

      // Recent memory should be present, old one filtered out
      expect(body.context).toContain("Recent project knowledge");
      expect(body.context).not.toContain("Ancient project knowledge");
    });
  });
});