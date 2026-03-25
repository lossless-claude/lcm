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
