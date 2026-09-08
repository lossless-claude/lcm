import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHarness,
  openProjectDb,
  type HarnessHandle,
} from "../harness.js";
import { findUncompacted } from "../../../src/batch-compact.js";
import { projectDir, projectId } from "../../../src/daemon/project.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = join(root, "dist/bin/lcm.js");

let harness: HarnessHandle;
let fakeHome: string;
let projectCwd: string;

function codexTranscript(sessionId: string, cwd: string, marker: string): string {
  return [
    {
      timestamp: "2026-09-08T08:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd, cli_version: "0.100.0", model_provider: "openai" },
    },
    {
      timestamp: "2026-09-08T08:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${marker} user message` }],
      },
    },
    {
      timestamp: "2026-09-08T08:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `${marker} assistant message` }],
      },
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function runImport(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "import", ...args], {
      cwd: harness.tmpDir,
      env: {
        ...process.env,
        HOME: fakeHome,
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(stderr || "replay CLI timed out"));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  if (!existsSync(cli)) {
    throw new Error("Build the CLI before running Codex replay process tests");
  }

  harness = await createHarness("mock");
  projectCwd = realpathSync(harness.tmpDir);
  fakeHome = join(harness.tmpDir, "home");

  const configDir = join(fakeHome, ".lossless-claude");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ daemon: { port: harness.daemonPort } }),
  );
  const fakeProjects = join(configDir, "projects");
  const daemonProject = projectDir(projectCwd);
  mkdirSync(fakeProjects, { recursive: true });
  mkdirSync(daemonProject, { recursive: true });
  symlinkSync(daemonProject, join(fakeProjects, projectId(projectCwd)), "dir");

  const claudeProject = join(
    fakeHome,
    ".claude",
    "projects",
    projectCwd.replace(/\//g, "-"),
  );
  mkdirSync(claudeProject, { recursive: true });
  copyFileSync(harness.fixturePath, join(claudeProject, "claude-current.jsonl"));

  const active = join(fakeHome, ".codex", "sessions", "2026", "09", "08");
  const archived = join(fakeHome, ".codex", "archived_sessions");
  mkdirSync(active, { recursive: true });
  mkdirSync(archived, { recursive: true });
  writeFileSync(
    join(active, "codex-active.jsonl"),
    codexTranscript("codex-active", projectCwd, "active-codex"),
  );
  writeFileSync(
    join(archived, "codex-archived.jsonl"),
    codexTranscript("codex-archived", projectCwd, "archived-codex"),
  );
  writeFileSync(
    join(active, "codex-foreign.jsonl"),
    codexTranscript("codex-foreign", join(projectCwd, "foreign"), "foreign-codex"),
  );
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

describe("Codex replay through the built CLI", { timeout: 120_000 }, () => {
  it("defaults bare replay to both providers while preserving explicit provider selection", async () => {
    const replay = await runImport(["--dry-run", "--replay"]);
    expect(replay.code, replay.stderr).toBe(0);
    expect(replay.stdout).toContain("3 all sessions selected (current project); would compact each session");

    const claude = await runImport(["--dry-run", "--replay", "--provider", "claude"]);
    expect(claude.code, claude.stderr).toBe(0);
    expect(claude.stdout).toContain("1 claude sessions selected (current project); would compact each session");

    const codex = await runImport(["--dry-run", "--replay", "--codex"]);
    expect(codex.code, codex.stderr).toBe(0);
    expect(codex.stdout).toContain("2 codex sessions selected (current project); would compact each session");
  });

  it("processes active and archived Codex sessions once and resumes without duplicates", async () => {
    const first = await runImport(["--replay"]);
    expect(first.code, first.stderr).toBe(0);

    const { db, close } = openProjectDb(harness.tmpDir);
    let firstLedgerCount: number;
    let firstMessageCount: number;
    try {
      const sessions = db.prepare(
        "SELECT session_id FROM conversations ORDER BY session_id",
      ).all() as { session_id: string }[];
      expect(sessions.map((row) => row.session_id)).toEqual([
        "claude-current",
        "codex-active",
        "codex-archived",
      ]);

      const codexMessages = db.prepare(`
        SELECT c.session_id, m.content
        FROM messages m
        JOIN conversations c ON c.conversation_id = m.conversation_id
        WHERE c.session_id IN ('codex-active', 'codex-archived')
        ORDER BY c.session_id, m.seq
      `).all() as { session_id: string; content: string }[];
      expect(codexMessages.map((row) => row.content)).toEqual([
        "active-codex user message",
        "active-codex assistant message",
        "archived-codex user message",
        "archived-codex assistant message",
      ]);

      firstLedgerCount = (db.prepare(
        "SELECT COUNT(*) AS n FROM replay_ledger",
      ).get() as { n: number }).n;
      firstMessageCount = (db.prepare(
        "SELECT COUNT(*) AS n FROM messages",
      ).get() as { n: number }).n;
      expect(firstLedgerCount).toBe(3);
    } finally {
      close();
    }

    const batchReplaySessions = findUncompacted(0, true, projectCwd, true)
      .map((conversation) => conversation.sessionId)
      .sort();
    expect(batchReplaySessions).toEqual([
      "claude-current",
      "codex-active",
      "codex-archived",
    ]);

    const second = await runImport(["--replay"]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("resuming: 1/1 done, 0 remaining");
    expect(second.stdout).toContain("resuming: 2/2 done, 0 remaining");

    const reopened = openProjectDb(harness.tmpDir);
    try {
      const ledgerCount = (reopened.db.prepare(
        "SELECT COUNT(*) AS n FROM replay_ledger",
      ).get() as { n: number }).n;
      const messageCount = (reopened.db.prepare(
        "SELECT COUNT(*) AS n FROM messages",
      ).get() as { n: number }).n;
      expect(ledgerCount).toBe(firstLedgerCount);
      expect(messageCount).toBe(firstMessageCount);
    } finally {
      reopened.close();
    }
  });
});
