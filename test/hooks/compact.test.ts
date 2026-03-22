import { describe, it, expect, vi } from "vitest";
import { handlePreCompact } from "../../src/hooks/compact.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);

describe("handlePreCompact", () => {
  it("returns exitCode 2 and summary when daemon healthy", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn().mockResolvedValue({ summary: "Compacted 500 tokens" }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Compacted");
    expect(client.post).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({ client: "claude" }),
    );
  });

  it("returns exitCode 0 when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handlePreCompact("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
