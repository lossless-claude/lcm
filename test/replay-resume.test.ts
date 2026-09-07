import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { projectId } from "../src/daemon/project.js";
import {
  clearReplayState,
  createReplayRun,
  fingerprintFile,
  fingerprintStats,
  planReplayResume,
  recordReplayProgress,
  replayRunId,
} from "../src/replay-resume.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-replay-resume-"));
  tempDirs.push(dir);
  return dir;
}

/** Create a project DB (with migrations) under a fake lcmDir and return its path. */
function makeProjectDb(lcmDir: string, cwd: string): string {
  const dir = join(lcmDir, "projects", projectId(cwd));
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "db.sqlite");
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db, { fts5Available: false });
  db.close();
  return dbPath;
}

function insertSummary(dbPath: string, summaryId: string, content: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "INSERT INTO conversations (session_id) VALUES (?) ON CONFLICT DO NOTHING",
    ).run(`conv-for-${summaryId}`);
    const conv = db.prepare("SELECT conversation_id FROM conversations ORDER BY conversation_id DESC LIMIT 1").get() as { conversation_id: number };
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', ?, 10)",
    ).run(summaryId, conv.conversation_id, content);
  } finally {
    db.close();
  }
}

function ledgerRows(dbPath: string, runId: string): { session_id: string; summary_id: string | null; prev_session_id: string | null }[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(
      "SELECT session_id, summary_id, prev_session_id FROM replay_ledger WHERE run_id = ? ORDER BY position",
    ).all(runId) as { session_id: string; summary_id: string | null; prev_session_id: string | null }[];
  } finally {
    db.close();
  }
}

describe("fingerprintFile", () => {
  it("is stable when the file does not change", () => {
    const dir = makeTmpDir();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    expect(fingerprintFile(path)).toBe(fingerprintFile(path));
  });

  it("changes when content is appended", () => {
    const dir = makeTmpDir();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, '{"a":1}\n');
    const before = fingerprintFile(path);
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    expect(fingerprintFile(path)).not.toBe(before);
  });

  it("changes when only mtime moves", () => {
    const dir = makeTmpDir();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, '{"a":1}\n');
    const before = fingerprintFile(path);
    const t = new Date(Date.now() + 60_000);
    utimesSync(path, t, t);
    expect(fingerprintFile(path)).not.toBe(before);
  });
});

describe("fingerprintStats", () => {
  it("encodes message count and tokens", () => {
    expect(fingerprintStats(10, 500)).toBe("db:10:500");
    expect(fingerprintStats(10, 500)).not.toBe(fingerprintStats(11, 500));
  });
});

describe("replay run manifest + ledger", () => {
  it("creates a manifest and records ledger rows", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-project";
    const dbPath = makeProjectDb(lcmDir, cwd);
    const runId = replayRunId();

    createReplayRun({
      cwd, lcmDir, command: "import", runId,
      sessions: [{ sessionId: "s1" }, { sessionId: "s2" }],
      model: "test-model",
    });

    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: "fp1", summaryId: "sum-1", model: "test-model",
    });

    const rows = ledgerRows(dbPath, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].summary_id).toBe("sum-1");
  });

  it("resume skips done sessions with matching fingerprints", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-resume";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-1", "summary one");
    insertSummary(dbPath, "sum-2", "summary two");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    const f2 = join(dir, "s2.jsonl");
    const f3 = join(dir, "s3.jsonl");
    writeFileSync(f1, "one\n");
    writeFileSync(f2, "two\n");
    writeFileSync(f3, "three\n");

    const sessions = [f1, f2, f3].map((p, i) => ({ sessionId: `s${i + 1}`, path: p }));
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions, model: "m" });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: fingerprintFile(f1), summaryId: "sum-1", model: "m",
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, prevSessionId: "s1",
      contentFingerprint: fingerprintFile(f2), summaryId: "sum-2", model: "m",
    });

    const plan = planReplayResume({
      cwd, lcmDir, command: "import", sessions,
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.runId).toBe(runId);
    expect(plan.doneCount).toBe(2);
    expect(plan.remaining.map((s) => s.sessionId)).toEqual(["s3"]);
    expect(plan.restoredPreviousSummary).toBe("summary two");
    expect(plan.droppedPreviousSummary).toBeUndefined();
    expect(plan.changedSessionId).toBeNull();
  });

  it("reprocesses a session whose transcript changed and reports it", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-changed";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-1", "summary one");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    const f2 = join(dir, "s2.jsonl");
    writeFileSync(f1, "one\n");
    writeFileSync(f2, "two\n");

    const sessions = [{ sessionId: "s1", path: f1 }, { sessionId: "s2", path: f2 }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: fingerprintFile(f1), summaryId: "sum-1",
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, prevSessionId: "s1",
      contentFingerprint: fingerprintFile(f2), summaryId: null,
    });

    // s2's transcript grows (claude --resume appended to it)
    writeFileSync(f2, "two\ngrown\n");

    const plan = planReplayResume({
      cwd, lcmDir, command: "import", sessions,
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.doneCount).toBe(1);
    expect(plan.remaining.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(plan.changedSessionId).toBe("s2");
    // Chain before s2 is intact (s1 has a summary), so it is restored
    expect(plan.restoredPreviousSummary).toBe("summary one");
  });

  it("drops the restored chain when an earlier link was broken (null summary)", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-broken-chain";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-2", "summary two");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    const f2 = join(dir, "s2.jsonl");
    const f3 = join(dir, "s3.jsonl");
    writeFileSync(f1, "one\n");
    writeFileSync(f2, "two\n");
    writeFileSync(f3, "three\n");

    const sessions = [f1, f2, f3].map((p, i) => ({ sessionId: `s${i + 1}`, path: p }));
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    // s1 completed but produced no summary (broken link)
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: fingerprintFile(f1), summaryId: null,
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, prevSessionId: "s1",
      contentFingerprint: fingerprintFile(f2), summaryId: "sum-2",
    });

    const plan = planReplayResume({
      cwd, lcmDir, command: "import", sessions,
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.doneCount).toBe(2);
    expect(plan.restoredPreviousSummary).toBeUndefined();
    expect(plan.droppedPreviousSummary).toBe("summary two");
  });

  it("restart returns everything and ignores prior progress", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-restart";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-1", "summary one");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    writeFileSync(f1, "one\n");
    const sessions = [{ sessionId: "s1", path: f1 }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: fingerprintFile(f1), summaryId: "sum-1",
    });

    const plan = planReplayResume({
      cwd, lcmDir, command: "import", sessions,
      fingerprint: (s) => fingerprintFile(s.path),
      restart: true,
    });

    expect(plan.previousRunId).toBeNull();
    expect(plan.doneCount).toBe(0);
    expect(plan.remaining).toHaveLength(1);
  });

  it("clearReplayState removes ledger, manifest, and recorded summaries only", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-clear";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-replay", "replay summary");
    insertSummary(dbPath, "sum-hook", "hook summary");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    writeFileSync(f1, "one\n");
    const sessions = [{ sessionId: "s1", path: f1 }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, prevSessionId: null,
      contentFingerprint: fingerprintFile(f1), summaryId: "sum-replay",
    });

    clearReplayState({ cwd, lcmDir, command: "import" });

    const db = new DatabaseSync(dbPath);
    try {
      const manifests = db.prepare("SELECT COUNT(*) AS n FROM replay_manifest").get() as { n: number };
      const ledger = db.prepare("SELECT COUNT(*) AS n FROM replay_ledger").get() as { n: number };
      const replaySum = db.prepare("SELECT 1 FROM summaries WHERE summary_id = 'sum-replay'").get();
      const hookSum = db.prepare("SELECT 1 FROM summaries WHERE summary_id = 'sum-hook'").get();
      expect(manifests.n).toBe(0);
      expect(ledger.n).toBe(0);
      expect(replaySum).toBeUndefined(); // replay output removed
      expect(hookSum).toBeDefined();     // hook output preserved
    } finally {
      db.close();
    }
  });

  it("gracefully handles a missing project DB", () => {
    const lcmDir = makeTmpDir();
    const plan = planReplayResume({
      cwd: "/test/no-db", lcmDir, command: "import",
      sessions: [{ sessionId: "s1" }],
      fingerprint: () => "fp",
    });
    expect(plan.previousRunId).toBeNull();
    expect(plan.remaining).toHaveLength(1);
    // record/clear must not throw either
    recordReplayProgress({
      cwd: "/test/no-db", lcmDir, runId: "r", sessionId: "s1", position: 0,
      prevSessionId: null, contentFingerprint: "fp",
    });
    clearReplayState({ cwd: "/test/no-db", lcmDir, command: "import" });
  });

  it("keeps manifests from older runs (history is not rotated)", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-history";
    makeProjectDb(lcmDir, cwd);

    const run1 = replayRunId();
    const run2 = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId: run1, sessions: [{ sessionId: "s1" }] });
    createReplayRun({ cwd, lcmDir, command: "import", runId: run2, sessions: [{ sessionId: "s1" }] });

    const db = new DatabaseSync(join(lcmDir, "projects", projectId(cwd), "db.sqlite"));
    try {
      const runs = db.prepare("SELECT DISTINCT run_id FROM replay_manifest").all() as { run_id: string }[];
      expect(runs.map((r) => r.run_id).sort()).toEqual([run1, run2].sort());
    } finally {
      db.close();
    }
  });
});
