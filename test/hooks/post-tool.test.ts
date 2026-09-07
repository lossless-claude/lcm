// test/hooks/post-tool.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock eventsDbPath to use temp directory
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

describe("handlePostToolUse", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-tool-test-"));
    process.env.TEST_EVENTS_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("captures AskUserQuestion decision", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      tool_input: { question: "Use SQLite?" },
      tool_response: "yes",
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("returns empty stdout (PostToolUse hooks don't produce output)", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/some/file.ts" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits gracefully on invalid stdin", async () => {
    const result = await handlePostToolUse("not json");
    expect(result.exitCode).toBe(0); // silent fail
  });

  it("skips sensitive file paths", async () => {
    const stdin = JSON.stringify({
      session_id: "test-session",
      tool_name: "Read",
      tool_input: { file_path: "/project/.env" },
    });
    const result = await handlePostToolUse(stdin);
    expect(result.exitCode).toBe(0);
  });

  it("fires priority-1 promotion at the configured daemon port, not the default", async () => {
    vi.mocked(firePromoteEventsRequest).mockClear();
    await handlePostToolUse(JSON.stringify({
      session_id: "test-session",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which db?" }] },
      tool_response: "postgres",
    }));
    expect(firePromoteEventsRequest).toHaveBeenCalledWith(4242, expect.objectContaining({ cwd: expect.any(String) }));
  });
});
