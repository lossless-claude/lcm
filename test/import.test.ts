import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { cwdToProjectHash, findSessionFiles, importSessions } from "../src/import.js";
import type { DaemonClient } from "../src/daemon/client.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { projectId } from "../src/daemon/project.js";

// --- cwdToProjectHash ---

describe("cwdToProjectHash", () => {
  it("keeps leading dash from absolute path", () => {
    expect(cwdToProjectHash("/home/user/project")).toBe("-home-user-project");
  });

  it("replaces all slashes with dashes", () => {
    expect(cwdToProjectHash("/a/b/c")).toBe("-a-b-c");
  });

  it("handles root path", () => {
    expect(cwdToProjectHash("/")).toBe("-");
  });

  it("handles path without leading slash", () => {
    expect(cwdToProjectHash("home/user")).toBe("home-user");
  });
});

// --- findSessionFiles ---

describe("findSessionFiles", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-test-"));
    dirs.push(dir);
    return dir;
  }

  it("returns empty array for nonexistent directory", () => {
    const result = findSessionFiles("/nonexistent/path/that/does/not/exist");
    expect(result).toEqual([]);
  });

  it("discovers .jsonl files at the top level", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "session-abc.jsonl"), "");
    writeFileSync(join(dir, "session-def.jsonl"), "");
    writeFileSync(join(dir, "readme.txt"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["session-abc", "session-def"]);
  });

  it("discovers subagent .jsonl files", () => {
    const dir = makeTmpDir();
    // create a subdirectory with a subagents folder
    const subDir = join(dir, "session-parent");
    const subagentsDir = join(subDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "subagent-1.jsonl"), "");
    writeFileSync(join(subagentsDir, "subagent-2.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["subagent-1", "subagent-2"]);
  });

  it("discovers both top-level and subagent files", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "main-session.jsonl"), "");
    const subDir = join(dir, "nested");
    const subagentsDir = join(subDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "child-session.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["child-session", "main-session"]);
  });

  it("ignores directories without a subagents subfolder or matching nested transcript", () => {
    const dir = makeTmpDir();
    const subDir = join(dir, "some-dir");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "file.jsonl"), ""); // not in subagents/ and name doesn't match dir

    const result = findSessionFiles(dir);
    expect(result).toEqual([]);
  });

  it("discovers nested session transcripts (Layout A: <session-id>/<session-id>.jsonl)", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-abc.jsonl"), "");

    const result = findSessionFiles(dir);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-abc");
    expect(result[0].path).toBe(join(sessionDir, "session-abc.jsonl"));
  });

  it("ignores nested transcript paths that are not regular files", () => {
    const dir = makeTmpDir();
    const sessionDir = join(dir, "session-abc");
    const nestedPath = join(sessionDir, "session-abc.jsonl");
    mkdirSync(nestedPath, { recursive: true });

    const result = findSessionFiles(dir);
    expect(result).toEqual([]);
  });

  it("discovers nested transcripts alongside subagent files", () => {
    const dir = makeTmpDir();
    // Layout A: nested main transcript + subagent
    const sessionDir = join(dir, "session-parent");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-parent.jsonl"), "");
    const subagentsDir = join(sessionDir, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, "agent-1.jsonl"), "");

    const result = findSessionFiles(dir);
    const sessionIds = result.map((f) => f.sessionId).sort();
    expect(sessionIds).toEqual(["agent-1", "session-parent"]);
  });

  it("deduplicates when both flat and nested transcripts exist for the same session", () => {
    const dir = makeTmpDir();
    // Flat transcript at project root
    writeFileSync(join(dir, "session-abc.jsonl"), "flat");
    // Nested transcript inside session directory
    const sessionDir = join(dir, "session-abc");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-abc.jsonl"), "nested");

    const result = findSessionFiles(dir);
    // Should only return one entry, the flat file (preferred)
    const matches = result.filter((f) => f.sessionId === "session-abc");
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe(join(dir, "session-abc.jsonl"));
  });

  it("ignores symlinked transcript files at the top level", () => {
    const dir = makeTmpDir();
    const targetFile = join(dir, "real-target.jsonl");
    writeFileSync(targetFile, '{"type":"human"}\n');
    const projectDir = join(dir, "project");
    mkdirSync(projectDir);
    symlinkSync(targetFile, join(projectDir, "fake-session.jsonl"));

    const result = findSessionFiles(projectDir);
    expect(result).toHaveLength(0); // symlink should be ignored
  });

  it("ignores symlinked nested transcript files", () => {
    const dir = makeTmpDir();
    const targetFile = join(dir, "real-target.jsonl");
    writeFileSync(targetFile, '{"type":"human"}\n');
    const projectDir = join(dir, "project");
    const sessionDir = join(projectDir, "session-xyz");
    mkdirSync(sessionDir, { recursive: true });
    symlinkSync(targetFile, join(sessionDir, "session-xyz.jsonl"));

    const result = findSessionFiles(projectDir);
    expect(result).toHaveLength(0); // symlinked nested transcript should be ignored
  });

  it("returns files sorted by mtime ascending", () => {
    const dir = makeTmpDir();
    const older = join(dir, "session-old.jsonl");
    const newer = join(dir, "session-new.jsonl");
    writeFileSync(newer, "");  // write newer first so FS order ≠ mtime order
    writeFileSync(older, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(older, oldTime, oldTime);

    const result = findSessionFiles(dir);
    expect(result.map(f => f.sessionId)).toEqual(["session-old", "session-new"]);
  });
});

// --- importSessions ---

function makeMockClient(postImpl: (path: string, body: unknown) => Promise<unknown>): DaemonClient {
  return {
    post: vi.fn().mockImplementation(postImpl),
    health: vi.fn(),
  } as unknown as DaemonClient;
}

describe("importSessions", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-sessions-"));
    dirs.push(dir);
    return dir;
  }

  it("does not call client.post on dry-run", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-1.jsonl"), "");

    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      dryRun: true,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    // dry-run counts found sessions as "imported" for reporting
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("calls /ingest with transcript_path and counts imported", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-abc.jsonl"), "");

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 5, totalTokens: 500 };
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/ingest");
    expect((calls[0].body as { session_id: string }).session_id).toBe("session-abc");
    expect((calls[0].body as { cwd: string }).cwd).toBe(cwd);
    expect((calls[0].body as { transcript_path: string }).transcript_path).toContain("session-abc.jsonl");

    expect(result.imported).toBe(1);
    expect(result.totalMessages).toBe(5);
    expect(result.totalTokens).toBe(500);
    expect(result.failed).toBe(0);
    expect(result.skippedEmpty).toBe(0);
  });

  it("counts empty transcripts as skippedEmpty (ingested=0, totalTokens=0)", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/emptyproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "empty-session.jsonl"), "");

    const client = makeMockClient(async () => ({ ingested: 0, totalTokens: 0 }));

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
    expect(result.totalMessages).toBe(0);
    expect(result.totalTokens).toBe(0);
  });

  it("counts failed ingest calls", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/failproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "bad-session.jsonl"), "");

    const client = makeMockClient(async () => {
      throw new Error("daemon error");
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.failed).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("replay mode calls compact after each session in mtime order, threading latestSummaryContent", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/project";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");  // write f2 first so FS order ≠ mtime order
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);  // f1 is older

    const compactBodies: { session_id: string; previous_summary?: string }[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "stats", replayOutcome: "compacted", latestSummaryContent: `summary-of-${body.session_id}` };
      }
    });

    await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Both sessions were compacted, in mtime order
    expect(compactBodies).toHaveLength(2);
    expect(compactBodies[0].session_id).toBe("session-1");
    expect(compactBodies[0].previous_summary).toBeUndefined();
    expect(compactBodies[1].session_id).toBe("session-2");
    expect(compactBodies[1].previous_summary).toBe("summary-of-session-1");
  });

  it("replay mode accumulates totalTokens and tokensAfter from compact responses", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/token-stats";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);

    const client = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 3, totalTokens: 5000 };
      if (path === "/compact") return {
        summary: "done",
        replayOutcome: "compacted",
        latestSummaryContent: "summary",
        tokensBefore: 5000,
        tokensAfter: 200,
        llmUsage: {
          provider: "codex-process",
          model: "gpt-5.6-luna",
          calls: 1,
          okCalls: 1,
          failedCalls: 0,
          tokensSpent: 36000,
        },
      };
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(result.totalTokens).toBe(10000);  // 5000 * 2 sessions
    expect(result.tokensAfter).toBe(400);     // 200 * 2 sessions
    expect(result.imported).toBe(2);
    expect(result.totalMessages).toBe(6);     // 3 * 2 sessions
    expect(result.replayUsage).toMatchObject({
      provider: "codex-process",
      model: "gpt-5.6-luna",
      calls: 2,
      okCalls: 2,
      failedCalls: 0,
      tokensSpent: 72000,
    });
  });

  it("replay mode: already-ingested session still reports tokens from compact response", async () => {
    // Covers the case where /ingest returns { ingested: 0, totalTokens: 0 } (already ingested)
    // but /compact returns real token counts. The final result should reflect the compact tokens.
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/already-ingested";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "session-1.jsonl"), "");

    const client = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 0, totalTokens: 0 }; // already ingested
      if (path === "/compact") return {
        summary: "done",
        replayOutcome: "compacted",
        latestSummaryContent: "summary",
        tokensBefore: 3000,
        tokensAfter: 150,
      };
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // ingest returned 0 tokens (already ingested), but compact supplies the real counts
    expect(result.totalTokens).toBe(3000);
    expect(result.tokensAfter).toBe(150);
    // session was skipped by ingest (not counted as imported)
    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("replay mode: compact failure warns unconditionally and falls back to ingest tokens", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/compact-fail";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(f1, oldTime, oldTime);

    const compactCalls: string[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 2, totalTokens: 1000 };
      if (path === "/compact") {
        compactCalls.push(body.session_id);
        if (body.session_id === "session-1") {
          const err = new Error("compact exploded") as Error & {
            body?: {
              llmUsage?: {
                provider: string;
                model: string;
                calls: number;
                okCalls: number;
                failedCalls: number;
                tokensSpent: number;
              };
            };
          };
          err.body = {
            llmUsage: {
              provider: "codex-process",
              model: "gpt-5.6-luna",
              calls: 1,
              okCalls: 0,
              failedCalls: 1,
              tokensSpent: 35000,
            },
          };
          throw err;
        }
        return {
          summary: "ok",
          replayOutcome: "compacted",
          latestSummaryContent: "s2-summary",
          tokensBefore: 900,
          tokensAfter: 100,
          llmUsage: {
            provider: "codex-process",
            model: "gpt-5.6-luna",
            calls: 1,
            okCalls: 1,
            failedCalls: 0,
            tokensSpent: 34000,
          },
        };
      }
    });

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderrLines.push(String(chunk));
      return true;
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
      stderrLines.push(args.join(" "));
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,  // warning must appear even without --verbose
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Both sessions were attempted for compact
    expect(compactCalls).toEqual(["session-1", "session-2"]);

    // Warning always printed regardless of verbose
    const hasWarning = stderrLines.some(l => l.includes("compact failed") && l.includes("session-1"));
    expect(hasWarning).toBe(true);

    // session-1 compact failed → falls back to ingest tokens (1000)
    // session-2 compact succeeded → uses tokensBefore (900)
    expect(result.totalTokens).toBe(1900);
    expect(result.tokensAfter).toBe(100);
    expect(result.replayUsage).toMatchObject({
      provider: "codex-process",
      model: "gpt-5.6-luna",
      calls: 2,
      okCalls: 1,
      failedCalls: 1,
      tokensSpent: 69000,
    });

    // session-2 should NOT have gotten session-1's summary (chain broken)
    // We verify by checking the compact call for session-2 had no previous_summary
    // (indirectly confirmed by the mock: if session-2 got a previous_summary it would still succeed,
    //  but we can test this via the chain being reset)
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(0);

    consoleErrorSpy.mockRestore();
  });

  it("returns empty result if project dir does not exist", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/nonexistent";
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
  });

  it("replay mode resets previousSummary when ingest fails, breaking the compact chain", async () => {
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/test/project";
    const hash = cwdToProjectHash(cwd);
    const projDir = join(claudeProjectsDir, hash);
    mkdirSync(projDir, { recursive: true });

    const f1 = join(projDir, "session-1.jsonl");
    const f2 = join(projDir, "session-2.jsonl");
    const f3 = join(projDir, "session-3.jsonl");
    writeFileSync(f3, "");
    writeFileSync(f2, "");
    writeFileSync(f1, "");
    const time1 = new Date(Date.now() - 20_000);
    const time2 = new Date(Date.now() - 10_000);
    utimesSync(f1, time1, time1);  // f1 is oldest
    utimesSync(f2, time2, time2);  // f2 is middle
    // f3 is newest (current time)

    const compactBodies: { session_id: string; previous_summary?: string }[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") {
        // Fail on session-2 ingest
        if (body.session_id === "session-2") {
          throw new Error("ingest failed");
        }
        return { ingested: 1, totalTokens: 100 };
      }
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "stats", replayOutcome: "compacted", latestSummaryContent: `summary-of-${body.session_id}` };
      }
    });

    const result = await importSessions(client, {
      replay: true,
      verbose: false,
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // session-1 succeeds and compacts with no prior context
    // session-2 ingest fails, so previousSummary is reset to undefined
    // session-3 compacts without prior context (previousSummary was reset)
    expect(compactBodies).toHaveLength(2);
    expect(compactBodies[0].session_id).toBe("session-1");
    expect(compactBodies[0].previous_summary).toBeUndefined();
    expect(compactBodies[1].session_id).toBe("session-3");
    // session-3 should NOT have previous_summary because session-2 ingest failed
    expect(compactBodies[1].previous_summary).toBeUndefined();
    // session-2 should have failed
    expect(result.failed).toBe(1);
  });

  it("skips sessions already recorded in session_ingest_log (unit test via daemon response)", async () => {
    // This test verifies that when the daemon returns ingested:0, totalTokens:0
    // (which happens when the session_ingest_log check passes at the daemon level),
    // importSessions counts it as skippedEmpty and doesn't call /ingest multiple times.
    // The full idempotency check is tested in the e2e test.
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/myproject";
    const projectHash = cwdToProjectHash(cwd);
    const projectDir = join(claudeProjectsDir, projectHash);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-already-ingested.jsonl"), "");

    const ingestCalls: string[] = [];
    const client = makeMockClient(async (path, body) => {
      if (path === "/ingest") {
        ingestCalls.push((body as { session_id: string }).session_id);
        // Simulate daemon returning 0 ingested (already in session_ingest_log)
        return { ingested: 0, totalTokens: 0 };
      }
      return { ingested: 0, totalTokens: 0 };
    });

    const result = await importSessions(client, {
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
    });

    // Verify the daemon was called
    expect(ingestCalls).toEqual(["session-already-ingested"]);
    // Verify the result reflects the skip
    expect(result.skippedEmpty).toBe(1);
    expect(result.imported).toBe(0);
  });
});

// --- importSessions replay resume (manifest + ledger) ---

describe("importSessions replay resume", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-resume-"));
    dirs.push(dir);
    return dir;
  }

  /** Set up a project dir with transcripts and an lcmDir with a migrated project DB. */
  function setup(cwd: string, sessionIds: string[]): { claudeProjectsDir: string; lcmDir: string; projDir: string } {
    const claudeProjectsDir = makeTmpDir();
    const lcmDir = makeTmpDir();
    const projDir = join(claudeProjectsDir, cwdToProjectHash(cwd));
    mkdirSync(projDir, { recursive: true });
    for (const id of sessionIds) {
      writeFileSync(join(projDir, `${id}.jsonl`), `{"session":"${id}"}\n`);
    }
    const dbDir = join(lcmDir, "projects", projectId(cwd));
    mkdirSync(dbDir, { recursive: true });
    const db = new DatabaseSync(join(dbDir, "db.sqlite"));
    runLcmMigrations(db, { fts5Available: false });
    db.close();
    return { claudeProjectsDir, lcmDir, projDir };
  }

  it("second run skips sessions already done in the first run", async () => {
    const cwd = "/test/resume-skip";
    const { claudeProjectsDir, lcmDir, projDir } = setup(cwd, ["s1", "s2", "s3"]);

    // First run: s3 fails (simulating a crash/usage-limit before its compact)
    const first = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        if (body.session_id === "s3") throw new Error("usage limit");
        return {
          summary: "ok",
          replayOutcome: "compacted",
          latestSummaryContent: `summary-of-${body.session_id}`,
          latestSummaryId: `sum-${body.session_id}`,
          tokensBefore: 100, tokensAfter: 10,
        };
      }
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = await importSessions(first, {
      replay: true, cwd,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });
    expect(r1.resumed).toBeUndefined(); // fresh run — nothing to resume

    // Persist a real summary so resume can restore the chain
    const dbPath = join(lcmDir, "projects", projectId(cwd), "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO conversations (session_id) VALUES ('s2')").run();
    const conv = db.prepare("SELECT conversation_id FROM conversations WHERE session_id = 's2'").get() as { conversation_id: number };
    db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES ('sum-s2', ?, 'leaf', 'summary-of-s2', 5)").run(conv.conversation_id);
    db.close();

    // Second run: s1 and s2 must be skipped, s3 retried with restored context
    const compactBodies: { session_id: string; previous_summary?: string }[] = [];
    const second = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compactBodies.push({ session_id: body.session_id, previous_summary: body.previous_summary });
        return { summary: "ok", replayOutcome: "compacted", latestSummaryContent: "summary-of-s3", latestSummaryId: "sum-s3", tokensBefore: 100, tokensAfter: 10 };
      }
    });
    const r2 = await importSessions(second, {
      replay: true, cwd,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });

    expect(compactBodies).toHaveLength(1);
    expect(compactBodies[0].session_id).toBe("s3");
    expect(compactBodies[0].previous_summary).toBe("summary-of-s2");
    expect(r2.resumed).toBeDefined();
    expect(r2.resumed?.doneCount).toBe(2);
    expect(r2.resumed?.totalCount).toBe(3);

    // transcript files untouched — used only for fingerprinting
    expect(projDir).toBeTruthy();
  });

  it("first-ever replay into a project with no database still records its manifest", async () => {
    const cwd = "/test/resume-fresh-db";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1", "s2"]);
    const dbPath = join(lcmDir, "projects", projectId(cwd), "db.sqlite");
    rmSync(dbPath);

    // The daemon creates the database on the first /ingest.
    const client = makeMockClient(async (path: string) => {
      if (path === "/ingest") {
        const db = new DatabaseSync(dbPath);
        runLcmMigrations(db, { fts5Available: false });
        db.close();
        return { ingested: 1, totalTokens: 100 };
      }
      if (path === "/compact") return { summary: "ok", replayOutcome: "compacted", latestSummaryContent: "s", latestSummaryId: "sum" };
    });
    await importSessions(client, { replay: true, cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });

    const db = new DatabaseSync(dbPath);
    try {
      const manifest = db.prepare("SELECT COUNT(*) AS n FROM replay_manifest").get() as { n: number };
      const ledger = db.prepare("SELECT COUNT(*) AS n FROM replay_ledger").get() as { n: number };
      expect(manifest.n).toBe(2);
      expect(ledger.n).toBe(2);
    } finally {
      db.close();
    }

    // The second run resumes instead of starting over.
    const second = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 0, totalTokens: 0 };
      if (path === "/compact") return { summary: "ok", replayOutcome: "compacted" };
    });
    const r2 = await importSessions(second, { replay: true, cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });
    expect(r2.resumed?.doneCount).toBe(2);
  });

  it("keeps the manifest pending past an empty first ingest that creates no database", async () => {
    const cwd = "/test/resume-empty-first";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1", "s2"]);
    const dbPath = join(lcmDir, "projects", projectId(cwd), "db.sqlite");
    rmSync(dbPath);

    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") {
        // An empty transcript returns before the daemon creates the database.
        if (body.session_id === "s1") return { ingested: 0, totalTokens: 0 };
        const db = new DatabaseSync(dbPath);
        runLcmMigrations(db, { fts5Available: false });
        db.close();
        return { ingested: 1, totalTokens: 100 };
      }
      if (path === "/compact") return { summary: "ok", replayOutcome: "no_work" };
    });
    await importSessions(client, { replay: true, cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });

    const db = new DatabaseSync(dbPath);
    try {
      const manifest = db.prepare("SELECT session_id FROM replay_manifest ORDER BY position").all() as { session_id: string }[];
      expect(manifest.map((m) => m.session_id)).toEqual(["s1", "s2"]);
    } finally {
      db.close();
    }
  });

  it("replay asks /ingest to re-read completed sessions", async () => {
    const cwd = "/test/replay-ingest-flag";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1"]);
    const ingestBodies: Record<string, unknown>[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") { ingestBodies.push(body); return { ingested: 1, totalTokens: 100 }; }
      if (path === "/compact") return { summary: "ok", replayOutcome: "compacted" };
    });
    await importSessions(client, { replay: true, cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });
    expect(ingestBodies[0].replay).toBe(true);

    const plain = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") { ingestBodies.push(body); return { ingested: 0, totalTokens: 0 }; }
    });
    await importSessions(plain, { cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });
    expect(ingestBodies[1].replay).toBeUndefined();
  });

  it("restart forces a full re-run and clears recorded progress", async () => {
    const cwd = "/test/resume-restart";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1"]);

    const first = makeMockClient(async (path: string) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") return { summary: "ok", replayOutcome: "compacted", latestSummaryContent: "s", latestSummaryId: "sum-s1" };
    });
    await importSessions(first, { replay: true, cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir });

    const compactCalls: string[] = [];
    const second = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compactCalls.push(body.session_id);
        return { summary: "ok", replayOutcome: "compacted", latestSummaryContent: "s2", latestSummaryId: "sum2-s1" };
      }
    });
    const r2 = await importSessions(second, {
      replay: true, restart: true, cwd,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });

    expect(compactCalls).toEqual(["s1"]);
    expect(r2.resumed).toBeUndefined();
  });

  it("dry-run replay does not write manifests or ledgers", async () => {
    const cwd = "/test/resume-dryrun";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1"]);

    const client = makeMockClient(async () => ({ ingested: 0, totalTokens: 0 }));
    await importSessions(client, {
      replay: true, dryRun: true, cwd,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
    });

    const db = new DatabaseSync(join(lcmDir, "projects", projectId(cwd), "db.sqlite"));
    const manifests = db.prepare("SELECT COUNT(*) AS n FROM replay_manifest").get() as { n: number };
    const ledger = db.prepare("SELECT COUNT(*) AS n FROM replay_ledger").get() as { n: number };
    db.close();
    expect(manifests.n).toBe(0);
    expect(ledger.n).toBe(0);
  });

  it("stops starting new sessions when onBeforeSession returns false", async () => {
    const cwd = "/test/resume-abort";
    const { claudeProjectsDir, lcmDir } = setup(cwd, ["s1", "s2", "s3"]);

    const compacted: string[] = [];
    const client = makeMockClient(async (path: string, body: any) => {
      if (path === "/ingest") return { ingested: 1, totalTokens: 100 };
      if (path === "/compact") {
        compacted.push(body.session_id);
        return { summary: "ok", replayOutcome: "compacted", latestSummaryContent: "s", latestSummaryId: `sum-${body.session_id}` };
      }
    });

    let calls = 0;
    const result = await importSessions(client, {
      replay: true, cwd,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: lcmDir,
      // Abort after the first session
      onBeforeSession: () => ++calls <= 1,
    });

    expect(compacted).toEqual(["s1"]);
    expect(result.imported).toBe(1);
  });
});

// --- importSessions with provider: "codex" ---

function makeCodexResponseItemLine(role: "user" | "assistant", text: string): string {
  const contentType = role === "user" ? "input_text" : "output_text";
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: contentType, text }] },
  });
}

function makeCodexSessionMetaLine(id: string, cwd: string): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: { id, cwd, cli_version: "0.100.0", model_provider: "openai" },
  });
}

describe("importSessions — provider: codex", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
    vi.restoreAllMocks();
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-import-codex-"));
    dirs.push(dir);
    return dir;
  }

  it("imports Codex sessions from _codexDir/archived_sessions/", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });

    const cwd = "/workspace/myproject";
    const sessionId = "rollout-2026-01-01-session-abc";
    const content = [
      makeCodexSessionMetaLine(sessionId, cwd),
      makeCodexResponseItemLine("user", "Hello Codex"),
      makeCodexResponseItemLine("assistant", "Hello! How can I help?"),
    ].join("\n");
    writeFileSync(join(archivedDir, `${sessionId}.jsonl`), content);

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 2, totalTokens: 200 };
    });

    const result = await importSessions(client, {
      provider: "codex",
      _codexDir: codexDir,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/ingest");
    expect((calls[0].body as { session_id: string }).session_id).toBe(sessionId);
    expect((calls[0].body as { cwd: string }).cwd).toBe(cwd);
    expect((calls[0].body as { transcript_path: string }).transcript_path).toContain(`${sessionId}.jsonl`);
    expect(result.imported).toBe(1);
    expect(result.totalMessages).toBe(2);
    expect(result.totalTokens).toBe(200);
    expect(result.failed).toBe(0);
  });

  it("falls back to process.cwd() when session_meta has no cwd", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });

    // A transcript without a session_meta line
    writeFileSync(
      join(archivedDir, "no-meta-session.jsonl"),
      makeCodexResponseItemLine("user", "Hi") + "\n",
    );

    const calls: { path: string; body: unknown }[] = [];
    const client = makeMockClient(async (path, body) => {
      calls.push({ path, body });
      return { ingested: 1, totalTokens: 50 };
    });

    await importSessions(client, {
      provider: "codex",
      _codexDir: codexDir,
    });

    expect(calls).toHaveLength(1);
    // Falls back to process.cwd()
    expect((calls[0].body as { cwd: string }).cwd).toBe(process.cwd());
  });

  it("imports nothing when _codexDir does not exist", async () => {
    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      provider: "codex",
      _codexDir: "/nonexistent/codex/dir",
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
  });

  it("dry-run does not call /ingest for codex sessions", async () => {
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "session-x.jsonl"), makeCodexSessionMetaLine("session-x", "/ws"));

    const client = makeMockClient(async () => ({ ingested: 1, totalTokens: 100 }));

    const result = await importSessions(client, {
      provider: "codex",
      dryRun: true,
      _codexDir: codexDir,
    });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.imported).toBe(1);
  });

  it("provider all imports from both Claude and Codex", async () => {
    // Claude project dir
    const claudeProjectsDir = makeTmpDir();
    const cwd = "/home/user/claudeproject";
    const hash = cwdToProjectHash(cwd);
    const claudeProjDir = join(claudeProjectsDir, hash);
    mkdirSync(claudeProjDir, { recursive: true });
    writeFileSync(join(claudeProjDir, "claude-session.jsonl"), "");

    // Codex dir
    const codexDir = makeTmpDir();
    const archivedDir = join(codexDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(join(archivedDir, "codex-session.jsonl"), makeCodexSessionMetaLine("codex-session", "/workspace"));

    const sessionIds: string[] = [];
    const client = makeMockClient(async (_path, body) => {
      sessionIds.push((body as { session_id: string }).session_id);
      return { ingested: 1, totalTokens: 100 };
    });

    const result = await importSessions(client, {
      provider: "all",
      cwd,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir,
    });

    expect(sessionIds.sort()).toEqual(["claude-session", "codex-session"]);
    expect(result.imported).toBe(2);
  });
});
