import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath } from "../../../src/daemon/project.js";

// ---------------------------------------------------------------------------
// Base scoring math — mirrors the pre-feedback score in prompt-search.
// ---------------------------------------------------------------------------

function scoreResult(opts: {
  rank: number;
  ageHours: number;
  halfLife: number;
  sessionId: string | null;
  querySessionId: string | null | undefined;
  crossSessionAffinity: number;
}): number {
  const recencyFactor = Math.pow(0.5, opts.ageHours / opts.halfLife);

  let sessionAffinity: number;
  if (opts.querySessionId == null) {
    sessionAffinity = 1.0;
  } else if (opts.sessionId === opts.querySessionId) {
    sessionAffinity = 1.0;
  } else {
    sessionAffinity = opts.crossSessionAffinity;
  }

  return Math.abs(opts.rank) * recencyFactor * sessionAffinity;
}

const HALF_LIFE = 24;   // default recencyHalfLifeHours
const AFFINITY = 0.85;  // default crossSessionAffinity
const MIN_SCORE = 2;    // default promptSearchMinScore

describe("composite scoring math", () => {
  describe("recency_factor = Math.pow(0.5, ageHours / halfLife)", () => {
    it("is 1.0 at age 0h", () => {
      expect(Math.pow(0.5, 0 / HALF_LIFE)).toBeCloseTo(1.0, 10);
    });

    it("is 0.5 at age 24h (one half-life)", () => {
      expect(Math.pow(0.5, 24 / HALF_LIFE)).toBeCloseTo(0.5, 10);
    });

    it("is 0.25 at age 48h (two half-lives)", () => {
      expect(Math.pow(0.5, 48 / HALF_LIFE)).toBeCloseTo(0.25, 10);
    });
  });

  describe("session_affinity", () => {
    it("is 1.0 when query has no session context (session_id = null)", () => {
      const score = scoreResult({
        rank: -10, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: "sess-a", querySessionId: null,
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(10, 5);
    });

    it("is 1.0 for same-session result", () => {
      const score = scoreResult({
        rank: -10, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: "sess-x", querySessionId: "sess-x",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(10, 5);
    });

    it("is crossSessionAffinity (0.85) for a different-session result", () => {
      const score = scoreResult({
        rank: -10, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: "sess-a", querySessionId: "sess-b",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(8.5, 5);
    });

    it("is crossSessionAffinity (0.85) when result has null sessionId and query has a session", () => {
      const score = scoreResult({
        rank: -10, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: null, querySessionId: "sess-b",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(8.5, 5);
    });
  });

  describe("composite score = abs(rank) * recency * affinity", () => {
    it("fresh same-session memory with rank -15 scores ~15 (above threshold 2)", () => {
      // recency=1.0, affinity=1.0 → 15 * 1.0 * 1.0 = 15
      const score = scoreResult({
        rank: -15, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: "s1", querySessionId: "s1",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(15, 5);
      expect(score).toBeGreaterThanOrEqual(MIN_SCORE);
    });

    it("48h-old cross-session memory with rank -15 scores ~3.19 (above threshold 2)", () => {
      // recency=0.25, affinity=0.85 → 15 * 0.25 * 0.85 = 3.1875
      const score = scoreResult({
        rank: -15, ageHours: 48, halfLife: HALF_LIFE,
        sessionId: "sess-a", querySessionId: "sess-b",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(3.1875, 5);
      expect(score).toBeGreaterThanOrEqual(MIN_SCORE);
    });

    it("72h-old cross-session memory with rank -5 scores ~0.53 (below threshold 2)", () => {
      // recency=Math.pow(0.5,3)=0.125, affinity=0.85 → 5 * 0.125 * 0.85 = 0.53125
      const score = scoreResult({
        rank: -5, ageHours: 72, halfLife: HALF_LIFE,
        sessionId: "sess-a", querySessionId: "sess-b",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeCloseTo(0.53125, 5);
      expect(score).toBeLessThan(MIN_SCORE);
    });
  });

  describe("threshold filter", () => {
    it("passes results with score >= minScore", () => {
      const score = scoreResult({
        rank: -15, ageHours: 0, halfLife: HALF_LIFE,
        sessionId: "s", querySessionId: "s",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeGreaterThanOrEqual(MIN_SCORE);
    });

    it("rejects results with score < minScore", () => {
      const score = scoreResult({
        rank: -5, ageHours: 72, halfLife: HALF_LIFE,
        sessionId: "sess-a", querySessionId: "sess-b",
        crossSessionAffinity: AFFINITY,
      });
      expect(score).toBeLessThan(MIN_SCORE);
    });
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /prompt-search", () => {
  it("returns hints for matching promoted entries", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-"));
    tempDirs.push(tempDir);

    // Pre-populate promoted table
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Database is PostgreSQL running on port 5432", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    // Set minScore to 0 so all FTS5 matches pass the filter (rank is always negative)
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React frontend", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[]; ids: string[] };
      expect(res.status).toBe(200);
      expect(Array.isArray(data.hints)).toBe(true);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0]).toContain("React");
      // ids should be present and parallel to hints
      expect(Array.isArray(data.ids)).toBe(true);
      expect(data.ids.length).toBe(data.hints.length);
      expect(typeof data.ids[0]).toBe("string");
    } finally {
      await daemon.stop();
    }
  });

  it("logs surfacing events to recall_surfacing table", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-recall-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const insertedId = store.insert({ content: "Use TypeScript everywhere", tags: [], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript", cwd: tempDir, session_id: "sess-recall" }),
      });

      // Verify surfacing was logged
      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT memory_id, session_id FROM recall_surfacing WHERE memory_id = ?"
      ).get(insertedId) as { memory_id: string; session_id: string } | undefined;
      verifyDb.close();

      expect(row).toBeDefined();
      expect(row?.memory_id).toBe(insertedId);
      expect(row?.session_id).toBe("sess-recall");
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when no entries match", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-nomatch-"));
    tempDirs.push(tempDir);

    // Pre-populate with unrelated content
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: "We decided to use React for the frontend", tags: ["decision"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    // High minScore to filter out weak matches
    config.restoration.promptSearchMinScore = 999;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when no db exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-nodb-"));
    tempDirs.push(tempDir);

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "something", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns empty hints when query or cwd is missing", async () => {
    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      // Missing query
      const res1 = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/some/dir" }),
      });
      const data1 = await res1.json() as { hints: string[] };
      expect(res1.status).toBe(200);
      expect(data1.hints).toEqual([]);

      // Missing cwd
      const res2 = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "something" }),
      });
      const data2 = await res2.json() as { hints: string[] };
      expect(res2.status).toBe(200);
      expect(data2.hints).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });

  it("returns hints for same-session entries and filters via minScore when session_id provided", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-session-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    // Same-session entry — should pass score filter
    store.insert({ content: "We agreed to use TypeScript for all modules", tags: [], projectId: "p1", sessionId: "sess-current" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0; // let FTS rank decide
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript modules", cwd: tempDir, session_id: "sess-current" }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0]).toContain("TypeScript");
    } finally {
      await daemon.stop();
    }
  });

  it("truncates long content to snippetLength", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-truncate-"));
    tempDirs.push(tempDir);

    const longContent = "React " + "x".repeat(300);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    store.insert({ content: longContent, tags: [], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSnippetLength = 50;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "React", cwd: tempDir }),
      });
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0].length).toBeLessThanOrEqual(53); // 50 + "..."
      expect(data.hints[0].endsWith("...")).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("reranks acted-upon memories above otherwise similar unused memories", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-usage-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const unusedId = store.insert({ content: "Use SQLite for project storage in background jobs", tags: ["decision"], projectId: "p1" });
    const usedId = store.insert({ content: "Use SQLite for project storage in the main service", tags: ["decision"], projectId: "p1" });
    store.insert({ content: "Acted on stored memory", tags: ["signal:memory_used", `memory_id:${usedId}`], projectId: "p1" });
    store.insert({ content: "Acted on stored memory again", tags: ["signal:memory_used", `memory_id:${usedId}`], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.recallUsageBoost = 1.5;
    config.restoration.recallUsageSmoothing = 1;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "SQLite storage", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; usageCount: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(usedId);
      expect(data.ids).toContain(unusedId);
      expect(data.debug.candidates[0].id).toBe(usedId);
      expect(data.debug.candidates[0].usageCount).toBe(2);
      expect(data.debug.candidates[0].finalScore).toBeGreaterThan(data.debug.candidates[1].finalScore);
    } finally {
      await daemon.stop();
    }
  });

  it("suppresses recently surfaced memories unless they clear the resurface margin", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-cooldown-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const cooledId = store.insert({ content: "TypeScript build convention", tags: ["decision"], projectId: "p1" });
    const freshId = store.insert({ content: "TypeScript build convention", tags: ["decision"], projectId: "p1" });
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(cooledId, "sess-a");
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 10;
    config.restoration.unusedSurfacingPenalty = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript build", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; cooledDown: boolean }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([freshId]);
      expect(data.ids).not.toContain(cooledId);
      expect(data.debug.candidates.find((candidate) => candidate.id === cooledId)).toMatchObject({
        id: cooledId,
        cooledDown: true,
      });
      expect(data.debug.candidates.find((candidate) => candidate.id === freshId)).toMatchObject({
        id: freshId,
        cooledDown: false,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to the best cooled candidate when every eligible result is in cooldown", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-all-cooled-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({ content: "TypeScript build convention", tags: ["workflow"], projectId: "p1" });
    const secondId = store.insert({ content: "TypeScript build convention", tags: ["workflow"], projectId: "p1" });
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(firstId, "sess-a");
    db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(secondId, "sess-b");
    store.insert({ content: "Acted on first cooled memory", tags: ["signal:memory_used", `memory_id:${firstId}`], projectId: "p1" });
    store.insert({ content: "Acted on second cooled memory", tags: ["signal:memory_used", `memory_id:${secondId}`], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.surfacingCooldownWindow = 24;
    config.restoration.resurfaceMargin = 10;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "TypeScript build", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; cooledDown: boolean; surfaced: boolean }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([firstId]);
      expect(data.hints).toHaveLength(1);
      expect(data.debug.candidates).toHaveLength(2);
      expect(data.debug.candidates.every((candidate) => candidate.cooledDown)).toBe(true);
      expect(data.debug.candidates.filter((candidate) => candidate.surfaced)).toEqual([
        expect.objectContaining({ id: firstId, surfaced: true }),
      ]);
    } finally {
      await daemon.stop();
    }
  });

  it("penalizes repeatedly surfaced memories that were never acted upon", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-unused-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const staleId = store.insert({ content: "Bun test runner", tags: ["workflow"], projectId: "p1" });
    const freshId = store.insert({ content: "Bun test runner", tags: ["workflow"], projectId: "p1" });
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(staleId, `sess-${i}`);
    }
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.surfacingCooldownWindow = 0;
    config.restoration.unusedSurfacingPenalty = 1;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Bun test", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; surfacingCount: number; usageCount: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(freshId);
      expect(data.debug.candidates[0].id).toBe(freshId);
      expect(data.debug.candidates[0].usageCount).toBe(0);
      expect(data.debug.candidates[1]).toMatchObject({
        id: staleId,
        surfacingCount: 3,
        usageCount: 0,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("falls back to baseline ordering when no recall feedback exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-fallback-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({ content: "Node worker pool for queue jobs", tags: ["workflow"], projectId: "p1" });
    const secondId = store.insert({ content: "Node worker pool for background tasks", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "Node worker", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; usageCount: number; surfacingCount: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(firstId);
      expect(data.ids[1]).toBe(secondId);
      expect(data.debug.candidates[0]).toMatchObject({
        id: firstId,
        usageCount: 0,
        surfacingCount: 0,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("treats invalid created_at values as neutral recency instead of dropping results", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-invalid-created-at-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use deno fmt before commit", tags: ["workflow"], projectId: "p1" });
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run("not-a-date", memoryId);
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "deno fmt", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; baseScore: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toEqual([memoryId]);
      expect(data.debug.candidates[0]).toMatchObject({ id: memoryId });
      expect(Number.isFinite(data.debug.candidates[0].baseScore)).toBe(true);
      expect(Number.isFinite(data.debug.candidates[0].finalScore)).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("dedupes near-identical emitted hints before surfacing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-dedupe-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({ content: "Use Bun scripts for local automation and CI wrappers", tags: ["workflow"], projectId: "p1" });
    const secondId = store.insert({ content: "Use Bun scripts for local automation and CI wrappers with small wrappers", tags: ["workflow"], projectId: "p1" });
    const thirdId = store.insert({ content: "Bun scripts wrap local automation and CI tasks", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.maxInjectedMemoryItems = 3;
    config.restoration.dedupMinPrefix = 24;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "Use Bun scripts",
          cwd: tempDir,
          learningInstructionBytes: 900,
          debug: true,
        }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { budget: { dedupedCount: number; emittedCount: number } };
      };

      expect(res.status).toBe(200);
      expect(data.ids).toContain(firstId);
      expect(data.ids).not.toContain(secondId);
      expect(data.ids).toContain(thirdId);
      expect(data.debug.budget).toMatchObject({ dedupedCount: 1, emittedCount: 2 });
    } finally {
      await daemon.stop();
    }
  });

  it("drops lower-ranked hints when the final memory-context budget is exhausted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-budget-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const firstId = store.insert({ content: `Primary memory ${"alpha ".repeat(30)}`, tags: ["workflow"], projectId: "p1" });
    const secondId = store.insert({ content: `Secondary memory ${"beta ".repeat(30)}`, tags: ["workflow"], projectId: "p1" });
    const thirdId = store.insert({ content: `Tertiary memory ${"gamma ".repeat(30)}`, tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.promptSnippetLength = 120;
    config.restoration.maxInjectedMemoryBytes = 1200;
    config.restoration.reservedForLearningInstruction = 900;
    config.restoration.maxInjectedMemoryItems = 3;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "memory",
          cwd: tempDir,
          learningInstructionBytes: 900,
          debug: true,
        }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { budget: { emittedCount: number; droppedForBudget: number; availableHintBytes: number; usedHintBytes: number } };
      };

      expect(res.status).toBe(200);
      expect(data.ids[0]).toBe(firstId);
      expect(data.ids).not.toContain(thirdId);
      expect(data.debug.budget.emittedCount).toBeLessThan(3);
      expect(data.debug.budget.droppedForBudget).toBeGreaterThan(0);
      expect(data.debug.budget.usedHintBytes).toBeLessThanOrEqual(data.debug.budget.availableHintBytes);
      expect(data.ids.every((id) => [firstId, secondId, thirdId].includes(id))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it("skips surfacing logs when the caller defers tracking to final emission", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-deferred-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use pnpm in CI", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "pnpm CI",
          cwd: tempDir,
          learningInstructionBytes: 900,
          logSurfacing: false,
        }),
      });

      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT COUNT(*) as count FROM recall_surfacing WHERE memory_id = ?"
      ).get(memoryId) as { count: number };
      verifyDb.close();

      expect(row.count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it("logs surfacing events when logSurfacing is enabled (default)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-prompt-search-log-enabled-"));
    tempDirs.push(tempDir);

    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);
    const memoryId = store.insert({ content: "Use pnpm in CI", tags: ["workflow"], projectId: "p1" });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "pnpm CI",
          cwd: tempDir,
          learningInstructionBytes: 900,
          // logSurfacing omitted, defaults to true
        }),
      });

      const verifyDb = new DatabaseSync(dbPath);
      const row = verifyDb.prepare(
        "SELECT COUNT(*) as count FROM recall_surfacing WHERE memory_id = ?"
      ).get(memoryId) as { count: number };
      verifyDb.close();

      expect(row.count).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });
});

describe("stale memory demotion", () => {
  it("applies stalePenalty to old memories surfaced without use", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-stale-prompt-"));
    tempDirs.push(tempDir);
    const dbPath = projectDbPath(tempDir);
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);
    const store = new PromotedStore(db);

    // Insert an old memory and backdate it
    const oldId = store.insert({
      content: "stale database indexing strategy old",
      tags: ["test"],
      projectId: "test-stale",
      confidence: 0.8,
    });
    const pastDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE promoted SET created_at = ? WHERE id = ?").run(pastDate, oldId);

    // Simulate surfacing without use (5 times)
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)").run(oldId, `s-${i}`);
    }

    // Insert a fresh memory
    const freshId = store.insert({
      content: "fresh database indexing strategy new",
      tags: ["test"],
      projectId: "test-stale",
      confidence: 0.8,
    });
    db.close();

    const config = loadDaemonConfig("/nonexistent");
    config.daemon.port = 0;
    config.restoration.promptSearchMinScore = 0;
    config.restoration.staleAfterDays = 90;
    config.restoration.staleSurfacingWithoutUseLimit = 5;
    config.restoration.stalePenalty = 0.5;
    config.restoration.allowStaleOnStrongMatch = true;

    const daemon = await createDaemon(config);
    const port = daemon.address().port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/prompt-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "database indexing strategy", cwd: tempDir, debug: true }),
      });
      const data = await res.json() as {
        hints: string[];
        ids: string[];
        debug: { candidates: Array<{ id: string; stalePenalty: number; finalScore: number }> };
      };

      expect(res.status).toBe(200);

      const oldCandidate = data.debug.candidates.find((c) => c.id === oldId);
      const freshCandidate = data.debug.candidates.find((c) => c.id === freshId);

      expect(oldCandidate).toBeDefined();
      expect(freshCandidate).toBeDefined();
      // Stale candidate should have a penalty applied
      expect(oldCandidate!.stalePenalty).toBeGreaterThan(0);
      // Fresh candidate should have no stale penalty
      expect(freshCandidate!.stalePenalty).toBe(0);
      // Fresh should rank higher than stale
      expect(freshCandidate!.finalScore).toBeGreaterThan(oldCandidate!.finalScore);
    } finally {
      await daemon.stop();
    }
  });
});
