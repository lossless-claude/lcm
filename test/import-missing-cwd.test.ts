import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSessions } from "../src/import.js";
import { printImportSummary } from "../src/import-summary.js";
import type { DaemonClient } from "../src/daemon/client.js";
import * as fs from "node:fs";
import { claudeProjectSlug, projectId } from "../src/daemon/project.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

describe("import with missing working directories", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function writeClaudeCandidates(root: string, cwd: string): string {
    const claudeProjectsDir = join(root, "claude");
    const claudeSessions = join(claudeProjectsDir, claudeProjectSlug(cwd));
    const projectDir = join(root, "lcm", "projects", projectId(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }));
    mkdirSync(join(claudeSessions, "claude", "subagents"), { recursive: true });
    writeFileSync(join(claudeSessions, "claude.jsonl"), JSON.stringify({
      type: "user", cwd, message: { role: "user", content: "hello" },
    }) + "\n");
    writeFileSync(join(claudeSessions, "claude", "subagents", "agent-child.jsonl"), JSON.stringify({
      type: "user", cwd, message: { role: "user", content: "child" },
    }) + "\n");
    return claudeProjectsDir;
  }

  it.each([true, false])("counts sessions only when commit repair skips a missing project (transcripts: %s)", async transcripts => {
    const root = mkdtempSync(join(tmpdir(), "lcm-import-missing-cwd-"));
    roots.push(root);
    const cwd = join(root, "removed-worktree");
    const claudeProjectsDir = transcripts ? writeClaudeCandidates(root, cwd) : join(root, "claude");
    if (!transcripts) {
      const projectDir = join(root, "lcm", "projects", projectId(cwd));
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "meta.json"), JSON.stringify({ cwd }));
    }
    const post = vi.fn();
    const result = await importSessions({ post } as unknown as DaemonClient, {
      all: true, provider: "claude", backfillEventTimes: true,
      _claudeProjectsDir: claudeProjectsDir, _lcmDir: join(root, "lcm"),
    });
    expect(post).not.toHaveBeenCalled();
    expect(result.skippedCwdMissing).toBe(transcripts ? 2 : 0);
  });

  it.each([false, true])("skips every source before posting and counts Claude parents and subagents (replay: %s)", async (replay) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-import-missing-cwd-"));
    roots.push(root);
    const cwd = join(root, "removed-worktree");
    const claudeProjectsDir = writeClaudeCandidates(root, cwd);
    const codexDir = join(root, "codex");
    const ompDir = join(root, "omp");
    const codexSessions = join(codexDir, "sessions");
    const ompSessions = join(ompDir, "sessions", "bucket");
    mkdirSync(codexSessions, { recursive: true });
    mkdirSync(ompSessions, { recursive: true });
    writeFileSync(join(codexSessions, "codex.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: "codex", cwd },
    }) + "\n");
    writeFileSync(join(ompSessions, "omp.jsonl"), JSON.stringify({
      type: "session", id: "omp", cwd,
    }) + "\n");
    const post = vi.fn().mockResolvedValue({ ingested: 0, totalTokens: 0 });
    const client = { post } as unknown as DaemonClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stat = vi.mocked(fs.statSync);
    stat.mockClear();
    const options = {
      all: true, replay, verbose: true,
      _claudeProjectsDir: claudeProjectsDir,
      _codexDir: codexDir, _ompDir: ompDir, _lcmDir: join(root, "lcm"),
    };

    const result = await importSessions(client, options);

    expect(post).not.toHaveBeenCalled();
    expect(stat.mock.calls.filter(([path]) => path === cwd)).toHaveLength(1);
    expect(result).toMatchObject({ imported: 0, skippedCwdMissing: 4, failed: 0 });
    expect(log).not.toHaveBeenCalled();
    printImportSummary(result, { replay });
    expect(log.mock.calls.map(([line]) => line).filter((line) => String(line).includes("cwd missing")))
      .toEqual(["  Skipped (cwd missing): 4"]);

    // A new run must reconsider the cwd, so restored worktrees can be captured.
    mkdirSync(cwd);
    const restored = await importSessions(client, { ...options, replay: false });
    expect(restored).toMatchObject({ skippedCwdMissing: 0, failed: 0 });
    expect(stat.mock.calls.filter(([path]) => path === cwd)).toHaveLength(2);
    expect(post.mock.calls.map(([route, body]) => [route, body.client]))
      .toEqual([["/ingest", undefined], ["/ingest", undefined], ["/ingest", "codex"], ["/ingest", "omp"]]);
  });

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EIO"])("checks Claude candidates and only skips absent cwd errors (%s)", async (code) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-import-missing-cwd-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const claudeProjectsDir = join(root, "claude");
    const sessions = join(claudeProjectsDir, claudeProjectSlug(cwd));
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "claude.jsonl"), JSON.stringify({
      type: "user", cwd, message: { role: "user", content: "hello" },
    }) + "\n");
    const actualStat = fs.statSync.getMockImplementation()!;
    vi.mocked(fs.statSync).mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === cwd) throw Object.assign(new Error(code), { code });
      return actualStat(...args);
    });
    const post = vi.fn().mockResolvedValue({ ingested: 1, totalTokens: 10 });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await importSessions({ post } as unknown as DaemonClient, {
      provider: "claude", cwd, _claudeProjectsDir: claudeProjectsDir, _lcmDir: join(root, "lcm"),
    });

    expect(fs.statSync).toHaveBeenCalledWith(cwd);
    if (code === "ENOENT" || code === "ENOTDIR") {
      expect(post).not.toHaveBeenCalled();
      expect(result).toMatchObject({ imported: 0, skippedCwdMissing: 1, failed: 0 });
    } else {
      expect(post).toHaveBeenCalledWith("/ingest", expect.objectContaining({ cwd, session_id: "claude" }));
      expect(result).toMatchObject({ imported: 1, skippedCwdMissing: 0, failed: 0 });
    }
  });

  it.skipIf(process.getuid?.() === 0)("posts a session whose cwd exists but cannot be read, so the daemon reports it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-import-missing-cwd-"));
    roots.push(root);
    const locked = join(root, "locked");
    const cwd = join(locked, "worktree");
    const codexDir = join(root, "codex");
    const codexSessions = join(codexDir, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    writeFileSync(join(codexSessions, "codex.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: "codex", cwd },
    }) + "\n");
    const post = vi.fn().mockResolvedValue({ ingested: 0, totalTokens: 0 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    chmodSync(locked, 0o000);
    try {
      const result = await importSessions({ post } as unknown as DaemonClient, {
        all: true, verbose: true,
        _claudeProjectsDir: join(root, "claude"),
        _codexDir: codexDir, _ompDir: join(root, "omp"), _lcmDir: join(root, "lcm"),
      });

      expect(result).toMatchObject({ skippedCwdMissing: 0 });
      expect(post.mock.calls.map(([route, body]) => [route, body.client])).toEqual([["/ingest", "codex"]]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.each([{ dryRun: true, isTTY: false }, { dryRun: false, isTTY: true }])
    ("reports missing cwd skips in the CLI summary: %j", async ({ dryRun, isTTY }) => {
      const { Command } = await import("commander");
      const importer = await import("../src/import.js");
      const { registerImportCommand } = await import("../src/cli/knowledge.js");
      vi.spyOn(importer, "importSessions").mockResolvedValue({
        imported: 0, skippedEmpty: 0, skippedCwdMissing: 2, failed: 0,
        totalMessages: 0, totalTokens: 0, tokensAfter: 0,
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
      const program = new Command();
      registerImportCommand(program, { createDaemonClientOrExit: async () => ({}) as DaemonClient });
      try {
        await program.parseAsync(["import", "--all", ...(dryRun ? ["--dry-run"] : [])], { from: "user" });
        expect(log.mock.calls.map(([line]) => line).filter((line) => String(line).includes("cwd missing")))
          .toEqual(["  Skipped (cwd missing): 2"]);
      } finally {
        if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
        else delete process.stdout.isTTY;
      }
    });
});
