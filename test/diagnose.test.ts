import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdToProjectHash } from "../src/import.js";
import { diagnose, scanSession } from "../src/diagnose.js";

function writeJsonl(filePath: string, entries: unknown[]) {
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

describe("diagnose", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "lcm-diagnose-"));
    dirs.push(dir);
    return dir;
  }

  function makeProjectDir(root: string, cwd: string): string {
    const dir = join(root, cwdToProjectHash(cwd));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("detects hook errors from nearby tool_result failures", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-hook-error";
    const projectDir = makeProjectDir(root, cwd);
    const filePath = join(projectDir, "session-hook.jsonl");

    writeJsonl(filePath, [
      { type: "custom-title", customTitle: "hook failures", sessionId: "session-hook" },
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "UserPromptSubmit",
          command: "lcm user-prompt",
        },
        parentToolUseID: "tool-1",
        toolUseID: "tool-1",
        timestamp: "2026-03-21T10:00:00.000Z",
      },
      {
        type: "user",
        timestamp: "2026-03-21T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              is_error: true,
              content: "stderr: lcm user-prompt failed with exit code 1",
            },
          ],
        },
      },
    ]);

    const session = await scanSession(filePath);
    expect(session.sessionName).toBe("hook failures");
    expect(session.errors).toContainEqual(
      expect.objectContaining({
        type: "hook-error",
        hookEvent: "UserPromptSubmit",
        command: "lcm user-prompt",
        count: 1,
      })
    );
  });

  it("detects MCP disconnect system messages", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-mcp-disconnect";
    const projectDir = makeProjectDir(root, cwd);
    const filePath = join(projectDir, "session-mcp.jsonl");

    writeJsonl(filePath, [
      {
        type: "system",
        subtype: "mcp",
        level: "error",
        timestamp: "2026-03-21T11:00:00.000Z",
        content: "MCP server lcm disconnected unexpectedly",
      },
    ]);

    const session = await scanSession(filePath);
    expect(session.errors).toContainEqual(
      expect.objectContaining({
        type: "mcp-disconnect",
        count: 1,
      })
    );
  });

  it("detects old binary hook commands and ignores path-only lossless-claude mentions", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-old-binary";
    const projectDir = makeProjectDir(root, cwd);
    const filePath = join(projectDir, "session-old-binary.jsonl");

    writeJsonl(filePath, [
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "SessionStart",
          command: "lossless-claude restore",
        },
        parentToolUseID: "tool-legacy",
        toolUseID: "tool-legacy",
        timestamp: "2026-03-21T12:00:00.000Z",
      },
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "PostToolUse",
          command: "node \"/Users/pedro/Developer/lossless-claude/scripts/helper.mjs\"",
        },
        parentToolUseID: "tool-path",
        toolUseID: "tool-path",
        timestamp: "2026-03-21T12:00:10.000Z",
      },
    ]);

    const session = await scanSession(filePath);
    const warnings = session.errors.filter((error) => error.type === "old-binary");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        type: "old-binary",
        command: "lossless-claude restore",
        count: 1,
      })
    );
  });

  it("detects duplicate hook firing for the same parentToolUseID hookEvent and command", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-duplicate-hooks";
    const projectDir = makeProjectDir(root, cwd);
    const filePath = join(projectDir, "session-duplicate.jsonl");

    writeJsonl(filePath, [
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "SessionStart",
          command: "lcm restore",
        },
        parentToolUseID: "tool-dup",
        toolUseID: "tool-dup",
        timestamp: "2026-03-21T13:00:00.000Z",
      },
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "SessionStart",
          command: "lcm restore",
        },
        parentToolUseID: "tool-dup",
        toolUseID: "tool-dup",
        timestamp: "2026-03-21T13:00:01.000Z",
      },
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "SessionStart",
          command: "lcm restore",
        },
        parentToolUseID: "tool-other",
        toolUseID: "tool-other",
        timestamp: "2026-03-21T13:00:02.000Z",
      },
    ]);

    const session = await scanSession(filePath);
    expect(session.errors).toContainEqual(
      expect.objectContaining({
        type: "duplicate-hook",
        hookEvent: "SessionStart",
        command: "lcm restore",
        count: 2,
      })
    );
  });

  it("filters sessions by mtime for the days option", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-days-filter";
    const projectDir = makeProjectDir(root, cwd);

    const recentPath = join(projectDir, "recent-session.jsonl");
    const oldPath = join(projectDir, "old-session.jsonl");
    writeJsonl(recentPath, [
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "UserPromptSubmit",
          command: "lossless-claude user-prompt",
        },
        parentToolUseID: "recent-tool",
        toolUseID: "recent-tool",
        timestamp: "2026-03-20T09:00:00.000Z",
      },
    ]);
    writeJsonl(oldPath, [
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "UserPromptSubmit",
          command: "lossless-claude user-prompt",
        },
        parentToolUseID: "old-tool",
        toolUseID: "old-tool",
        timestamp: "2026-03-01T09:00:00.000Z",
      },
    ]);

    const now = new Date("2026-03-21T12:00:00.000Z");
    const oneDayAgo = new Date("2026-03-20T12:00:00.000Z");
    const twentyDaysAgo = new Date("2026-03-01T12:00:00.000Z");
    utimesSync(recentPath, oneDayAgo, oneDayAgo);
    utimesSync(oldPath, twentyDaysAgo, twentyDaysAgo);

    const result = await diagnose({
      cwd,
      days: 7,
      _claudeProjectsDir: root,
      _nowMs: now.getTime(),
    });

    expect(result.sessionsScanned).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe("recent-session");
  });

  it("extracts the session name from custom-title entries during diagnose aggregation", async () => {
    const root = makeTmpDir();
    const cwd = "/tmp/project-session-name";
    const projectDir = makeProjectDir(root, cwd);
    const filePath = join(projectDir, "named-session.jsonl");

    writeJsonl(filePath, [
      { type: "custom-title", customTitle: "cli refactor", sessionId: "named-session" },
      {
        type: "progress",
        data: {
          type: "hook_progress",
          hookEvent: "SessionStart",
          command: "lossless-claude restore",
        },
        parentToolUseID: "tool-title",
        toolUseID: "tool-title",
        timestamp: "2026-03-21T14:00:00.000Z",
      },
    ]);

    const result = await diagnose({
      cwd,
      _claudeProjectsDir: root,
      _nowMs: new Date("2026-03-21T15:00:00.000Z").getTime(),
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionName).toBe("cli refactor");
  });
});
