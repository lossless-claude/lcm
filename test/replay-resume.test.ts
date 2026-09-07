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

function insertSummary(dbPath: string, summaryId: string, content: string, sessionId?: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const session = sessionId ?? `conv-for-${summaryId}`;
    db.prepare(
      "INSERT INTO conversations (session_id) VALUES (?) ON CONFLICT DO NOTHING",
    ).run(session);
    const conv = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(session) as { conversation_id: number };
    db.prepare(
      "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', ?, 10)",
    ).run(summaryId, conv.conversation_id, content);
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (?, (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM context_items WHERE conversation_id = ?), 'summary', ?)",
    ).run(conv.conversation_id, conv.conversation_id, summaryId);
  } finally {
    db.close();
  }
}

/** Add a raw message to a conversation so a rebuild has something to restore. */
function insertMessage(dbPath: string, sessionId: string, seq: number, content: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const conv = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = ?").get(sessionId) as { conversation_id: number };
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', ?, 5)",
    ).run(conv.conversation_id, seq, content);
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
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: "fp1", outcome: "compacted" as const, summaryId: "sum-1", model: "test-model",
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

    const sessions = [f1, f2, f3].map((p, i) => ({ sessionId: `s${i + 1}`, path: p, cwd }));
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions, model: "m" });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: fingerprintFile(f1), outcome: "compacted" as const, summaryId: "sum-1", model: "m",
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, contentFingerprint: fingerprintFile(f2), outcome: "compacted" as const, summaryId: "sum-2", model: "m",
    });

    const plan = planReplayResume({
      sessions, lcmDir, command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.runIds.get(cwd)).toBe(runId);
    expect(plan.freshCwds.size).toBe(0);
    expect(plan.doneCount).toBe(2);
    expect(plan.remaining.map((s) => s.sessionId)).toEqual(["s3"]);
    expect(plan.restoredPreviousSummaries.get(cwd)).toBe("summary two");
    expect(plan.droppedPreviousSummaries.get(cwd)).toBeUndefined();
    expect(plan.changedSessionIds).toEqual([]);
    expect(plan.positions.get(cwd)?.get("s1")).toBe(0);
    expect(plan.positions.get(cwd)?.get("s2")).toBe(1);
    expect(plan.positions.get(cwd)?.get("s3")).toBe(2);
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

    const sessions = [{ sessionId: "s1", path: f1, cwd }, { sessionId: "s2", path: f2, cwd }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: fingerprintFile(f1), outcome: "compacted" as const, summaryId: "sum-1",
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, contentFingerprint: fingerprintFile(f2), outcome: "compacted" as const, summaryId: null,
    });

    // s2's transcript grows (claude --resume appended to it)
    writeFileSync(f2, "two\ngrown\n");

    const plan = planReplayResume({
      sessions, lcmDir, command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.doneCount).toBe(1);
    expect(plan.remaining.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(plan.changedSessionIds).toEqual(["s2"]);
    // Chain before s2 is intact (s1 has a summary), so it is restored
    expect(plan.restoredPreviousSummaries.get(cwd)).toBe("summary one");
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

    const sessions = [f1, f2, f3].map((p, i) => ({ sessionId: `s${i + 1}`, path: p, cwd }));
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    // s1 completed but produced no summary (broken link)
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: fingerprintFile(f1), outcome: "compacted" as const, summaryId: null,
    });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s2", position: 1, contentFingerprint: fingerprintFile(f2), outcome: "compacted" as const, summaryId: "sum-2",
    });

    const plan = planReplayResume({
      sessions, lcmDir, command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
    });

    expect(plan.doneCount).toBe(2);
    expect(plan.restoredPreviousSummaries.get(cwd)).toBeUndefined();
    expect(plan.droppedPreviousSummaries.get(cwd)).toBe("summary two");
  });

  it("restart returns everything and ignores prior progress", () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-restart";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-1", "summary one");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    writeFileSync(f1, "one\n");
    const sessions = [{ sessionId: "s1", path: f1, cwd }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: fingerprintFile(f1), outcome: "compacted" as const, summaryId: "sum-1",
    });

    const plan = planReplayResume({
      sessions, lcmDir, command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
      restart: true,
    });

    expect(plan.freshCwds.has(cwd)).toBe(true);
    expect(plan.doneCount).toBe(0);
    expect(plan.remaining).toHaveLength(1);
    expect(plan.runIds.get(cwd)).not.toBe(runId);
  });

  it("clearReplayState wipes every summary in a touched conversation and rebuilds context", async () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-clear";
    const dbPath = makeProjectDb(lcmDir, cwd);
    // Both summaries live in the conversation the replay run touches, which is
    // the realistic case: a replay compacts on top of hook output.
    insertSummary(dbPath, "sum-replay", "replay summary", "s1");
    insertSummary(dbPath, "sum-hook", "hook summary", "s1");
    insertMessage(dbPath, "s1", 0, "raw message");

    const dir = makeTmpDir();
    const f1 = join(dir, "s1.jsonl");
    writeFileSync(f1, "one\n");
    const sessions = [{ sessionId: "s1", path: f1 }];
    const runId = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId, sessions });
    recordReplayProgress({
      cwd, lcmDir, runId, sessionId: "s1", position: 0, contentFingerprint: fingerprintFile(f1), outcome: "compacted" as const, summaryId: "sum-replay",
    });

    expect(await clearReplayState({ cwd, lcmDir, command: "import" })).toBe(true);

    const db = new DatabaseSync(dbPath);
    try {
      const manifests = db.prepare("SELECT COUNT(*) AS n FROM replay_manifest").get() as { n: number };
      const ledger = db.prepare("SELECT COUNT(*) AS n FROM replay_ledger").get() as { n: number };
      const replaySum = db.prepare("SELECT 1 FROM summaries WHERE summary_id = 'sum-replay'").get();
      const hookSum = db.prepare("SELECT 1 FROM summaries WHERE summary_id = 'sum-hook'").get();
      expect(manifests.n).toBe(0);
      expect(ledger.n).toBe(0);
      // Undo is wholesale: a replay summary can absorb a hook summary as a
      // parent, so scoping deletes to replay-owned ids would leave the
      // conversation missing them anyway. Nothing is lost — messages remain.
      expect(replaySum).toBeUndefined();
      expect(hookSum).toBeUndefined();

      // Context is rebuilt from the messages that were never deleted.
      const items = db.prepare(
        "SELECT item_type, ordinal FROM context_items ORDER BY ordinal",
      ).all() as { item_type: string; ordinal: number }[];
      expect(items).toEqual([{ item_type: "message", ordinal: 0 }]);
    } finally {
      db.close();
    }
  });

  it("clearReplayState drops the other command's ledger rows for the wiped sessions", async () => {
    const lcmDir = makeTmpDir();
    const cwd = "/test/replay-clear-cross";
    const dbPath = makeProjectDb(lcmDir, cwd);
    insertSummary(dbPath, "sum-s1", "summary", "s1");
    insertMessage(dbPath, "s1", 0, "raw message");

    const sessions = [{ sessionId: "s1" }];
    const importRun = replayRunId();
    const compactRun = replayRunId();
    createReplayRun({ cwd, lcmDir, command: "import", runId: importRun, sessions });
    createReplayRun({ cwd, lcmDir, command: "compact", runId: compactRun, sessions });
    recordReplayProgress({ cwd, lcmDir, runId: importRun, sessionId: "s1", position: 0, contentFingerprint: "a", outcome: "compacted" as const, summaryId: "sum-s1" });
    recordReplayProgress({ cwd, lcmDir, runId: compactRun, sessionId: "s1", position: 0, contentFingerprint: "db:1:5", outcome: "compacted" as const, summaryId: "sum-s1" });

    expect(await clearReplayState({ cwd, lcmDir, command: "import" })).toBe(true);

    const db = new DatabaseSync(dbPath);
    try {
      const ledger = db.prepare("SELECT COUNT(*) AS n FROM replay_ledger").get() as { n: number };
      const manifests = db.prepare("SELECT command FROM replay_manifest").all() as { command: string }[];
      // The summary is gone for both commands, so neither may still claim s1 done.
      expect(ledger.n).toBe(0);
      // The other command keeps its manifest and re-enqueues from the gap.
      expect(manifests.map((m) => m.command)).toEqual(["compact"]);
    } finally {
      db.close();
    }
  });

  it("gracefully handles a missing project DB", async () => {
    const lcmDir = makeTmpDir();
    const plan = planReplayResume({
      lcmDir, command: "import",
      sessions: [{ sessionId: "s1", cwd: "/test/no-db" }],
      fingerprint: () => "fp",
    });
    expect(plan.freshCwds.has("/test/no-db")).toBe(true);
    expect(plan.remaining).toHaveLength(1);
    // record/clear must not throw either
    recordReplayProgress({
      cwd: "/test/no-db", lcmDir, runId: "r", sessionId: "s1", position: 0,
      contentFingerprint: "fp", outcome: "compacted" as const,
    });
    expect(await clearReplayState({ cwd: "/test/no-db", lcmDir, command: "import" })).toBe(true);
  });

  it("spans multiple projects, keying manifest and ledger to each cwd", () => {
    const lcmDir = makeTmpDir();
    const cwdA = "/test/multi-a";
    const cwdB = "/test/multi-b";
    const dbA = makeProjectDb(lcmDir, cwdA);
    makeProjectDb(lcmDir, cwdB);
    insertSummary(dbA, "sum-a1", "summary a1");

    const dir = makeTmpDir();
    const fa1 = join(dir, "a1.jsonl");
    const fb1 = join(dir, "b1.jsonl");
    writeFileSync(fa1, "a\n");
    writeFileSync(fb1, "b\n");

    // Prior run only covered project A's session
    const runA = replayRunId();
    createReplayRun({ cwd: cwdA, lcmDir, command: "import", runId: runA, sessions: [{ sessionId: "a1" }] });
    recordReplayProgress({
      cwd: cwdA, lcmDir, runId: runA, sessionId: "a1", position: 0, contentFingerprint: fingerprintFile(fa1), outcome: "compacted" as const, summaryId: "sum-a1",
    });

    const sessions = [
      { sessionId: "a1", path: fa1, cwd: cwdA },
      { sessionId: "b1", path: fb1, cwd: cwdB },
    ];
    const plan = planReplayResume({
      sessions, lcmDir, command: "import",
      fingerprint: (s) => fingerprintFile(s.path),
    });

    // A resumed (a1 done), B is fresh (b1 remaining)
    expect(plan.freshCwds.has(cwdB)).toBe(true);
    expect(plan.freshCwds.has(cwdA)).toBe(false);
    expect(plan.runIds.get(cwdA)).toBe(runA);
    expect(plan.doneCount).toBe(1);
    expect(plan.remaining.map((s) => s.sessionId)).toEqual(["b1"]);
    expect(plan.manifests.get(cwdB)).toEqual(["b1"]);
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
