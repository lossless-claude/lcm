import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLcmPaths, type LcmPaths } from "../../src/lcm-paths.js";
import { lcmHome } from "../../src/lcm-home.js";
import type { SnapshotDeps } from "../../src/hooks/session-snapshot.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHookOutcomeLog } from "../../src/doctor/hook-outcome-log.js";

const paths: LcmPaths = createLcmPaths(lcmHome());

function makeDeps(overrides: Partial<SnapshotDeps> = {}): SnapshotDeps {
  return {
    statSync: vi.fn().mockReturnValue(null),
    writeFileSync: vi.fn(),
    snapshotIntervalSec: 60,
    post: vi.fn().mockResolvedValue({ ingested: 5 }),
    ...overrides,
  };
}

/**
 * The function-hooks claim lives at a fixed path under the shared temp dir, keyed by the session
 * id, so a fixed id lets a concurrent suite run claim or delete this run's file and the hook
 * answers for reasons the test never set up (#526). Ids are unique per process, so those files are.
 */
const sid = (name: string): string => `${name}-p${process.pid}`;

describe("handleSessionSnapshot", () => {
  it("stays silent while the function-hooks module holds the session", async () => {
    const { claimPath } = await import("../../src/hooks/session-claim.js");
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(claimPath(sid("abc-123")), JSON.stringify({ sessionId: sid("abc-123"), ts: Date.now() }));
    try {
      const deps = makeDeps();
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      const result = await handleSessionSnapshot(
        JSON.stringify({ session_id: sid("abc-123"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
        paths, deps,
      );
      expect(result).toEqual({ exitCode: 0, stdout: "" });
      expect(deps.post).not.toHaveBeenCalled();
      expect(deps.writeFileSync).not.toHaveBeenCalled();
    } finally {
      rmSync(claimPath(sid("abc-123")), { force: true });
    }
  });

  it("ingests when the module never claimed the session", async () => {
    const deps = makeDeps({ statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }) });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    await handleSessionSnapshot(
      JSON.stringify({ session_id: sid("unclaimed-1"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
    );
    expect(deps.post).toHaveBeenCalled();
  });

  it("ingests when no cursor file exists", async () => {
    const deps = makeDeps({
      statSync: vi.fn().mockImplementation(() => { throw new Error("ENOENT"); }),
    });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: sid("abc-123"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
    );
    expect(result.exitCode).toBe(0);
    expect(deps.post).toHaveBeenCalledWith("/ingest", {
      session_id: sid("abc-123"),
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
      JSON.stringify({ session_id: sid("abc-123"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
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
      JSON.stringify({ session_id: sid("abc-123"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
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
      JSON.stringify({ session_id: sid("abc-123"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
    );
    expect(result.exitCode).toBe(0);
  });

  it("keeps the retry timer eligible after an HTTP rejection", async () => {
    const deps = makeDeps({ post: vi.fn().mockResolvedValue({ ok: false, status: 401 }) });
    const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
    const result = await handleSessionSnapshot(
      JSON.stringify({ session_id: sid("rejected"), cwd: "/tmp/test", transcript_path: "/tmp/session.jsonl" }),
      paths, deps,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "" });
    expect(deps.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not label a local retry-timer write failure as a transport failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-stop-observation-"));
    try {
      const isolated = createLcmPaths(dir);
      const deps = makeDeps({ writeFileSync: vi.fn(() => { throw new Error("read-only cursor"); }) });
      const { handleSessionSnapshot } = await import("../../src/hooks/session-snapshot.js");
      await handleSessionSnapshot(JSON.stringify({
        session_id: sid("cursor-write"), cwd: dir, transcript_path: join(dir, "session.jsonl"),
      }), isolated, deps);
      const logged = readHookOutcomeLog(isolated.logsDir, dir);
      expect(logged.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "capture", status: "accepted" }),
        expect.objectContaining({ operation: "capture", status: "completed" }),
        expect.objectContaining({ operation: "retry-timer", status: "failed", reason: "write-error" }),
      ]));
      expect(logged.outcomes.some((item) => item.status === "unconfirmed")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
