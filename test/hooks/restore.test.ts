import { describe, it, expect, vi } from "vitest";
import { handleSessionStart } from "../../src/hooks/restore.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);

describe("handleSessionStart", () => {
  it("outputs context and exits 0 on success", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = {
      health: vi.fn(),
      post: vi.fn().mockResolvedValue({ context: "<memory-orientation>\nMemory active\n</memory-orientation>" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "SessionStart" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
  });

  it("exits 0 with empty output when daemon down", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handleSessionStart("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
