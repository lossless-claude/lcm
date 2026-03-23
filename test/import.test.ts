import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cwdToProjectHash, findSessionFiles, importSessions } from "../src/import.js";
import type { DaemonClient } from "../src/daemon/client.js";

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

  it("ignores directories without a subagents subfolder", () => {
    const dir = makeTmpDir();
    const subDir = join(dir, "some-dir");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "file.jsonl"), ""); // not in subagents/

    const result = findSessionFiles(dir);
    expect(result).toEqual([]);
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
        return { summary: "stats", latestSummaryContent: `summary-of-${body.session_id}` };
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
});
