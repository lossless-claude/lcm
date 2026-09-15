// test/hooks/codex-tool-events.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: () => ({ daemon: { port: 4242 } }),
}));
vi.mock("../../src/hooks/session-end.js", () => ({
  firePromoteEventsRequest: vi.fn(),
}));
import { firePromoteEventsRequest } from "../../src/hooks/session-end.js";

vi.mock("../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "test.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

import { dispatchCodexHook, type CodexHookDeps } from "../../src/hooks/codex.js";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { lcmHome } from "../../src/lcm-home.js";

// The events path is mocked above, so the root only has to be a valid one.
const paths = createLcmPaths(lcmHome());

function enabledDeps(): CodexHookDeps {
  return { client: { post: vi.fn() }, connect: vi.fn(async () => true), enabled: true, paths };
}

describe("Codex PostToolUse / PostToolUseFailure capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-tool-events-test-"));
    process.env.TEST_EVENTS_DIR = dir;
    vi.mocked(firePromoteEventsRequest).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("records a PostToolUse event tagged client=codex with the hook's model, without contacting the daemon", async () => {
    const deps = enabledDeps();
    const stdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'fix bug'" },
      tool_use_id: "call_1",
      model: "gpt-5.6-codex",
    });

    const result = await dispatchCodexHook(stdin, deps);
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(deps.connect).not.toHaveBeenCalled();

    const db = new EventsDb(join(dir, "test.db"));
    const [row] = db.getUnprocessed();
    expect(row).toMatchObject({
      session_id: "codex-session", type: "git_commit", category: "git",
      client: "codex", model: "gpt-5.6-codex", tool_use_id: "call_1",
    });
    db.close();
  });

  it("normalizes every native apply_patch file marker to a file edit event", async () => {
    await dispatchCodexHook(JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "apply_patch",
      tool_input: { command: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "*** Add File: src/new.ts",
        "*** Delete File: src/old.ts",
        "*** End Patch",
      ].join("\n") },
      tool_use_id: "call_patch",
    }), enabledDeps());

    const db = new EventsDb(join(dir, "test.db"));
    expect(db.getUnprocessed()).toEqual([
      expect.objectContaining({ type: "file_edit", category: "file", data: "src/example.ts (source)", client: "codex" }),
      expect.objectContaining({ type: "file_edit", category: "file", data: "src/new.ts (source)", client: "codex" }),
      expect.objectContaining({ type: "file_edit", category: "file", data: "src/old.ts (source)", client: "codex" }),
    ]);
    db.close();
  });

  it("does not classify an apply_patch payload without file markers as an edit", async () => {
    await dispatchCodexHook(JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "apply_patch",
      tool_input: { command: "not a recognized patch envelope" },
    }), enabledDeps());

    const db = new EventsDb(join(dir, "test.db"));
    expect(db.getUnprocessed()).toEqual([]);
    db.close();
  });

  it("does not classify the unsupported exec spelling as Bash", async () => {
    await dispatchCodexHook(JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "exec",
      tool_input: { command: "git commit -m 'must not be captured'" },
    }), enabledDeps());

    const db = new EventsDb(join(dir, "test.db"));
    expect(db.getUnprocessed()).toEqual([]);
    db.close();
  });

  it("records a PostToolUseFailure event the same way error_tool events are recorded for Claude", async () => {
    const deps = enabledDeps();
    const stdin = JSON.stringify({
      hook_event_name: "PostToolUseFailure",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Exit code 1",
      model: "gpt-5.6-codex",
    });

    await dispatchCodexHook(stdin, deps);

    const db = new EventsDb(join(dir, "test.db"));
    const [row] = db.getUnprocessed();
    expect(row).toMatchObject({ type: "error_tool", category: "error", client: "codex", model: "gpt-5.6-codex" });
    db.close();
  });

  it("fires priority-1 promotion the same way the Claude command hook does", async () => {
    const deps = enabledDeps();
    const stdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "codex-session",
      cwd: "/repo",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
      model: "gpt-5.6-codex",
    });

    await dispatchCodexHook(stdin, deps);
    expect(firePromoteEventsRequest).toHaveBeenCalledWith(4242, { cwd: "/repo" }, expect.anything());
  });

  it("ignores a non-tool hook_event_name and falls through to the lifecycle path", async () => {
    const deps = enabledDeps();
    const stdin = JSON.stringify({ hook_event_name: "NotARealEvent", session_id: "s", cwd: "/repo" });
    const result = await dispatchCodexHook(stdin, deps);
    expect(result).toEqual({ exitCode: 0, stdout: "" });
  });

  it("produces the same event rows as the Claude command hook for the same tool call, apart from client and model", async () => {
    const codexStdin = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "same-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'shared row shape'" },
      tool_use_id: "call_shared",
      model: "gpt-5.6-codex",
    });
    await dispatchCodexHook(codexStdin, enabledDeps());

    const claudeStdin = JSON.stringify({
      session_id: "same-session",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'shared row shape'" },
      tool_use_id: "toolu_shared",
    });
    await handlePostToolUse(claudeStdin, paths);

    const db = new EventsDb(join(dir, "test.db"));
    const rows = db.getUnprocessed();
    expect(rows).toHaveLength(2);
    const [codexRow, claudeRow] = rows;
    expect(codexRow.client).toBe("codex");
    expect(codexRow.model).toBe("gpt-5.6-codex");
    expect(claudeRow.client).toBe("claude");
    expect(claudeRow.model).toBeNull();
    for (const field of ["type", "category", "data", "priority", "source_hook"] as const) {
      expect(codexRow[field]).toEqual(claudeRow[field]);
    }
    db.close();
  });
});
