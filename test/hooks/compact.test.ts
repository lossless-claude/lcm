import { describe, it, expect, vi } from "vitest";
import { handlePreCompact } from "../../src/hooks/compact.js";
import { lcmHome } from "../../src/lcm-home.js";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn(),
}));

import { ensureDaemon } from "../../src/daemon/lifecycle.js";
const mockEnsureDaemon = vi.mocked(ensureDaemon);
const paths = createLcmPaths(lcmHome());
// The port the hook would get from dispatch; left out, the handler falls back to the
// default port and fires its promote-events request at whatever daemon listens there.
const port = loadDaemonConfig(paths.configPath).daemon.port;

describe("handlePreCompact", () => {
  it("returns exitCode 0 and summary when daemon healthy", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn().mockResolvedValue({ summary: "Compacted 500 tokens" }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any, paths, port);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Compacted");
    expect(client.post).toHaveBeenCalledWith(
      "/compact",
      expect.objectContaining({ client: "claude", capture_required: true }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("emits latestSummaryContent truncated to 2000 chars when present", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: true, port: 3737, spawned: false });
    const longContent = "x".repeat(3000);
    const client = { health: vi.fn(), post: vi.fn().mockResolvedValue({ summary: "Summary", latestSummaryContent: longContent }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any, paths, port);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Summary");
    expect(result.stdout).toContain("[truncated]");
    expect(result.stdout.length).toBeLessThan(longContent.length);
  });

  it("returns exitCode 0 when daemon unreachable", async () => {
    mockEnsureDaemon.mockResolvedValue({ connected: false, port: 3737, spawned: false });
    const client = { health: vi.fn(), post: vi.fn() };
    const result = await handlePreCompact("{}", client as any, paths, port);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open for a JSON null payload", async () => {
    const client = { post: vi.fn() };
    await expect(handlePreCompact("null", client as any, paths)).resolves.toEqual({ exitCode: 0, stdout: "" });
    expect(client.post).not.toHaveBeenCalled();
  });
});
