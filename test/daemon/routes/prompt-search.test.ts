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
// Pure scoring math — mirrors the formula in src/daemon/routes/prompt-search.ts
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
      const data = await res.json() as { hints: string[] };
      expect(res.status).toBe(200);
      expect(Array.isArray(data.hints)).toBe(true);
      expect(data.hints.length).toBeGreaterThanOrEqual(1);
      expect(data.hints[0]).toContain("React");
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
});
