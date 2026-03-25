import { describe, it, expect, vi } from "vitest";
import { HOOK_COMMANDS } from "../../src/hooks/dispatch.js";
import { REQUIRED_HOOKS } from "../../installer/install.js";

// Mock auto-heal to verify it's called
vi.mock("../../src/hooks/auto-heal.js", () => ({
  validateAndFixHooks: vi.fn(),
}));

// Mock all handler modules to avoid real daemon connections
vi.mock("../../src/hooks/compact.js", () => ({
  handlePreCompact: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/restore.js", () => ({
  handleSessionStart: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/session-end.js", () => ({
  handleSessionEnd: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/user-prompt.js", () => ({
  handleUserPromptSubmit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/session-snapshot.js", () => ({
  handleSessionSnapshot: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/hooks/post-tool.js", () => ({
  handlePostToolUse: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "" }),
}));
vi.mock("../../src/daemon/client.js", () => ({
  DaemonClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ daemon: { port: 3737 } }),
}));
vi.mock("../../src/bootstrap.js", () => ({
  ensureBootstrapped: vi.fn().mockResolvedValue(undefined),
}));

import { validateAndFixHooks } from "../../src/hooks/auto-heal.js";
import { dispatchHook, isHookCommand } from "../../src/hooks/dispatch.js";
import { ensureBootstrapped } from "../../src/bootstrap.js";

describe("HOOK_COMMANDS", () => {
  it("has an entry for every REQUIRED_HOOKS event", () => {
    const commandToEvent: Record<string, string> = {
      "compact": "PreCompact",
      "post-tool": "PostToolUse",
      "restore": "SessionStart",
      "session-end": "SessionEnd",
      "session-snapshot": "Stop",
      "user-prompt": "UserPromptSubmit",
    };
    for (const cmd of HOOK_COMMANDS) {
      expect(commandToEvent[cmd]).toBeDefined();
    }
    for (const { event } of REQUIRED_HOOKS) {
      const cmd = Object.entries(commandToEvent).find(([, e]) => e === event)?.[0];
      expect(HOOK_COMMANDS).toContain(cmd);
    }
  });
});

import { handlePreCompact } from "../../src/hooks/compact.js";
import { handleSessionStart } from "../../src/hooks/restore.js";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { handleUserPromptSubmit } from "../../src/hooks/user-prompt.js";
import { handleSessionSnapshot } from "../../src/hooks/session-snapshot.js";
import { handlePostToolUse } from "../../src/hooks/post-tool.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

describe("dispatchHook", () => {
  it("calls validateAndFixHooks before every handler", async () => {
    const callOrder: string[] = [];
    vi.mocked(validateAndFixHooks).mockImplementation(() => { callOrder.push("heal"); });
    vi.mocked(handlePreCompact).mockImplementation(async () => { callOrder.push("handler"); return { exitCode: 0, stdout: "" }; });

    callOrder.length = 0;
    await dispatchHook("compact", "{}");
    expect(callOrder).toEqual(["heal", "handler"]);
  });

  it("dispatches each command to its correct handler", async () => {
    const mapping: [typeof HOOK_COMMANDS[number], any][] = [
      ["compact", handlePreCompact],
      ["restore", handleSessionStart],
      ["session-end", handleSessionEnd],
      ["user-prompt", handleUserPromptSubmit],
    ];
    for (const [cmd, handler] of mapping) {
      vi.mocked(handler).mockClear();
      await dispatchHook(cmd, '{"test":true}');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith('{"test":true}', expect.anything(), expect.any(Number));
    }

    // session-snapshot takes only (stdinText, deps?) — no client/port
    vi.mocked(handleSessionSnapshot).mockClear();
    await dispatchHook("session-snapshot", '{"test":true}');
    expect(handleSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(handleSessionSnapshot).toHaveBeenCalledWith('{"test":true}');
  });

  it("passes configured port to handlers", async () => {
    vi.mocked(loadDaemonConfig).mockReturnValue({ daemon: { port: 9999 } } as any);
    vi.mocked(handlePreCompact).mockClear();
    await dispatchHook("compact", "{}");
    expect(handlePreCompact).toHaveBeenCalledWith("{}", expect.anything(), 9999);
    // Reset to default
    vi.mocked(loadDaemonConfig).mockReturnValue({ daemon: { port: 3737 } } as any);
  });

  it("calls ensureBootstrapped with session_id before dispatching", async () => {
    vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });
    vi.mocked(ensureBootstrapped).mockClear();
    await dispatchHook("compact", JSON.stringify({ session_id: "test-sess-123" }));
    expect(ensureBootstrapped).toHaveBeenCalledWith("test-sess-123");
  });

  it("does not block hooks if ensureBootstrapped throws", async () => {
    vi.mocked(ensureBootstrapped).mockRejectedValueOnce(new Error("bootstrap failed"));
    vi.mocked(handlePreCompact).mockResolvedValue({ exitCode: 0, stdout: "" });
    const result = await dispatchHook("compact", JSON.stringify({ session_id: "s1" }));
    expect(result.exitCode).toBe(0);
  });

  it("routes post-tool without calling ensureBootstrapped", async () => {
    vi.mocked(handlePostToolUse).mockClear();
    vi.mocked(ensureBootstrapped).mockClear();
    const result = await dispatchHook("post-tool", JSON.stringify({
      session_id: "test",
      tool_name: "Read",
      tool_input: { file_path: "/test.ts" },
    }));
    expect(result.exitCode).toBe(0);
    expect(handlePostToolUse).toHaveBeenCalledTimes(1);
    expect(ensureBootstrapped).not.toHaveBeenCalled();
  });

  it("recognizes post-tool as a valid hook command", () => {
    expect(isHookCommand("post-tool")).toBe(true);
  });
});
