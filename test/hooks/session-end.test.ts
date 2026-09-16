import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionEnd } from "../../src/hooks/session-end.js";
import { ensureDaemon } from "../../src/daemon/lifecycle.js";
import { readAuthToken } from "../../src/daemon/auth.js";
import { safeLogError } from "../../src/hooks/hook-errors.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createLcmPaths } from "../../src/lcm-paths.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));

vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({ hooks: {}, security: {} }),
}));

vi.mock("../../src/daemon/auth.js", () => ({
  readAuthToken: vi.fn().mockReturnValue("test-token-abc"),
}));

vi.mock("../../src/hooks/hook-errors.js", () => ({
  safeLogError: vi.fn(),
}));

const mockHttpReq = vi.hoisted(() => ({
  on: vi.fn().mockReturnThis(),
  write: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:http", () => ({
  request: vi.fn().mockReturnValue(mockHttpReq),
}));

const paths = createLcmPaths("/tmp/lcm-session-end-test");

function createMockClient(response: unknown = { queued: "scheduled" }) {
  return {
    post: vi.fn().mockImplementation((path: string) => {
      if (path === "/session-end") return Promise.resolve(response);
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }),
  } as any;
}

const notFound = Object.assign(new Error("HTTP 404"), { status: 404 });

/** A client whose /session-end 404s and whose /ingest resolves with `ingestResult`. */
function createLegacyDaemonClient(ingestResult: unknown = { ingested: 3 }) {
  return {
    post: vi.fn().mockImplementation((path: string) => {
      if (path === "/session-end") return Promise.reject(notFound);
      if (path === "/ingest") return Promise.resolve(ingestResult);
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }),
  } as any;
}

describe("handleSessionEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpReq.on.mockReturnThis();
    vi.mocked(ensureDaemon).mockResolvedValue({ connected: true } as any);
  });

  it("posts stdin once to /session-end and exits 0", async () => {
    const client = createMockClient();
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp", transcript_path: "/tmp/t.jsonl" });
    const result = await handleSessionEnd(stdin, client, paths, 3737);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(
      "/session-end",
      { session_id: "s1", cwd: "/tmp", transcript_path: "/tmp/t.jsonl" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("acknowledgement deadline fits the host's SessionEnd budget", async () => {
    const client = createMockClient();
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    const timeoutMs = client.post.mock.calls[0][2].timeoutMs as number;
    // Strictly under the ~1.5s host budget: the health probe before the post eats into it too.
    expect(timeoutMs).toBeLessThan(1500);
    expect(timeoutMs).toBeLessThanOrEqual(1000);
  });

  it("never spawns a daemon", async () => {
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), createMockClient(), paths, 3737);
    expect(ensureDaemon).toHaveBeenCalledWith(expect.objectContaining({ noSpawn: true, spawnTimeoutMs: 0 }));
  });

  it("exits 0 without posting when no daemon is up", async () => {
    vi.mocked(ensureDaemon).mockResolvedValueOnce({ connected: false } as any);
    const client = createMockClient();
    const result = await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(result.exitCode).toBe(0);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("exits 0 when the daemon rejects or times out, and logs the failure", async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error("timeout")) } as any;
    const result = await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(result.exitCode).toBe(0);
    expect(safeLogError).toHaveBeenCalledWith(
      "session-end",
      expect.objectContaining({ message: "timeout" }),
      expect.objectContaining({ sessionId: "s1", cwd: "/tmp" }),
    );
  });

  it("runs the pre-daemon-owned sequence when a compatible older daemon has no /session-end", async () => {
    const { request } = await import("node:http");
    const client = createLegacyDaemonClient({ ingested: 3 });
    const input = { session_id: "s1", cwd: "/tmp", transcript_path: "/tmp/t.jsonl" };
    const result = await handleSessionEnd(JSON.stringify(input), client, paths, 3737);
    expect(result.exitCode).toBe(0);

    // /ingest is awaited via the daemon client, not fired raw.
    expect(client.post).toHaveBeenCalledWith("/ingest", input, expect.objectContaining({ timeoutMs: expect.any(Number) }));

    // compact, promote, promote-events, session-complete follow, in order, fire-and-forget.
    const firedPaths = vi.mocked(request).mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(firedPaths).toEqual(["/compact", "/promote", "/promote-events", "/session-complete"]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      path: "/session-complete", method: "POST", port: 3737,
      headers: expect.objectContaining({ Authorization: "Bearer test-token-abc" }),
    }));
    expect(mockHttpReq.write).toHaveBeenLastCalledWith(
      JSON.stringify({ session_id: "s1", cwd: "/tmp", message_count: 3 }),
    );
  });

  it("skips /compact in the fallback sequence when disableAutoCompact is set", async () => {
    const { request } = await import("node:http");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({ hooks: { disableAutoCompact: true }, security: {} } as any);
    const client = createLegacyDaemonClient({ ingested: 1 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    const firedPaths = vi.mocked(request).mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(firedPaths).toEqual(["/promote", "/promote-events", "/session-complete"]);
  });

  it("fallback sequence still exits 0 when a later step's request setup throws", async () => {
    const { request } = await import("node:http");
    vi.mocked(request).mockImplementationOnce(() => { throw new Error("boom"); }).mockReturnValue(mockHttpReq as any);
    const client = createLegacyDaemonClient({ ingested: 1 });
    const result = await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(result.exitCode).toBe(0);
    expect(safeLogError).toHaveBeenCalledWith(
      "session-end",
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ sessionId: "s1", cwd: "/tmp" }),
    );
  });

  it("logs and still exits 0 when /ingest itself fails in the fallback", async () => {
    const client = {
      post: vi.fn().mockImplementation((path: string) =>
        path === "/session-end" ? Promise.reject(notFound) : Promise.reject(new Error("ingest failed")),
      ),
    } as any;
    const result = await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(result.exitCode).toBe(0);
    expect(safeLogError).toHaveBeenCalledWith(
      "session-end",
      expect.objectContaining({ message: "ingest failed" }),
      expect.objectContaining({ sessionId: "s1", cwd: "/tmp" }),
    );
  });

  it("defers socket.unref() until a fallback request body is flushed", async () => {
    const mockSocket = { unref: vi.fn() };
    let finish: (() => void) | undefined;
    mockHttpReq.on.mockImplementation((event: string, cb: (arg?: unknown) => void) => {
      if (event === "socket") cb(mockSocket);
      if (event === "finish") finish = cb as () => void;
      return mockHttpReq;
    });
    const client = createLegacyDaemonClient({ ingested: 1 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(mockSocket.unref).not.toHaveBeenCalled();
    finish?.();
    expect(mockSocket.unref).toHaveBeenCalled();
  });

  it("omits the Authorization header on the fallback when no daemon token exists", async () => {
    vi.mocked(readAuthToken).mockReturnValueOnce(null);
    const { request } = await import("node:http");
    const client = createLegacyDaemonClient({ ingested: 1 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    const call = vi.mocked(request).mock.calls[0][0] as { headers?: Record<string, string> };
    expect(call.headers?.Authorization).toBeUndefined();
  });

  it("does not fall back to the legacy sequence on any other failure", async () => {
    const { request } = await import("node:http");
    const client = { post: vi.fn().mockRejectedValue(Object.assign(new Error("HTTP 500"), { status: 500 })) } as any;
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, paths, 3737);
    expect(request).not.toHaveBeenCalled();
  });

  it("handles empty stdin gracefully", async () => {
    const result = await handleSessionEnd("", createMockClient(), paths, 3737);
    expect(result.exitCode).toBe(0);
  });
});
