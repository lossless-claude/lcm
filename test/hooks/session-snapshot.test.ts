import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SnapshotDeps } from "../../src/hooks/session-snapshot.js";

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    statSync: vi.fn().mockReturnValue(null),
    writeFileSync: vi.fn(),
    snapshotIntervalSec: 60,
    post: vi.fn().mockResolvedValue({ ingested: 5 }),
    ...overrides,
  };
}

describe("handleSessionSnapshot", () => {
  it("stays silent while the function-hooks module holds the session", async () => {
    process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
    const { claimPath } = await import("../../src/hooks/session-claim.js");
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(claimPath("abc-123"), JSON.stringify({ sessionId: "abc-123", ts: Date.now() }));
    try {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      const result = await handleSessionSnapshot(
        JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
        deps,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "" });
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.writeFileSync).not.toHaveBeenCalled();
    } finally {
      rmSync(claimPath("abc-123"), { force: true });
      delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
    }
  });

  it("ingests when the gate is open but the module never claimed the session", async () => {
    process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1";
    try {
      const deps = makeDeps({ statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }) });
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(
        JSON.stringify({ session_id: "unclaimed-1", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
        deps,
      );
      expect(deps.post).toHaveBeenCalled();
    } finally {
      delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS;
    }
  });

  it("ingests when no cursor file exists", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: "abc-123",
      cwd: "/tmp/test",
      transcript_path: "/tmp/session.jsonl",
    });
    expect(deps.writeFileSync).toHaveBeenCalled();
  });

  it("skips when throttled (cursor mtime < interval)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 10_000 }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it("ingests when cursor mtime exceeds interval", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockReturnValue({ mtimeMs: Date.now() - 120_000 }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalled();
  });

  it("returns exitCode 0 on error (never blocks Claude)", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
      post: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: "abc-123", cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      deps,
    );
    expect(result.exitCode).toBe(0);
  });
});
