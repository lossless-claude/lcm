import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSessionEnd } from "../../src/hooks/session-end.js";

vi.mock("../../src/daemon/lifecycle.js", () => ({
  ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
}));

vi.mock("../../src/daemon/config.js", () => ({
  loadDaemonConfig: vi.fn().mockReturnValue({
    compaction: { autoCompactMinTokens: 10000 },
  }),
}));

const mockHttpReq = vi.hoisted(() => ({
  on: vi.fn().mockReturnThis(),
  write: vi.fn(),
  end: vi.fn(),
}));

vi.mock("node:http", () => ({
  request: vi.fn().mockReturnValue(mockHttpReq),
}));

function createMockClient(ingestResponse: unknown) {
  return {
    post: vi.fn().mockImplementation((path: string) => {
      if (path === "/ingest") return Promise.resolve(ingestResponse);
      return Promise.reject(new Error(`unexpected path: ${path}`));
    }),
  } as any;
}

describe("handleSessionEnd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpReq.on.mockReturnThis();
  });

  it("calls /ingest with parsed stdin", async () => {
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(stdin, client, 3737);
    expect(result.exitCode).toBe(0);
    expect(client.post).toHaveBeenCalledWith("/ingest", { session_id: "s1", cwd: "/tmp" });
  });

  it("fires compact via http.request when totalTokens exceeds threshold", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 100, totalTokens: 25000 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/compact", method: "POST", port: 3737 }),
    );
    expect(mockHttpReq.end).toHaveBeenCalled();
  });

  it("fires compact even when totalTokens is below old threshold", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 500 });
    const stdin = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(stdin, client, 3737);
    const httpReqMock = vi.mocked(request);
    const compactCalls = httpReqMock.mock.calls.filter(
      (args: any[]) => args[0]?.path === "/compact",
    );
    expect(compactCalls.length).toBeGreaterThan(0);
  });

  it("skips compact when hooks.disableAutoCompact is true", async () => {
    const { loadDaemonConfig } = await import("../../src/daemon/config.js");
    vi.mocked(loadDaemonConfig).mockReturnValueOnce({
      compaction: { autoCompactMinTokens: 0 },
      hooks: { disableAutoCompact: true, snapshotIntervalSec: 60 },
    } as any);
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 100, totalTokens: 99999 });
    await handleSessionEnd(JSON.stringify({ session_id: "s1", cwd: "/tmp" }), client, 3737);
    const httpReqMock = vi.mocked(request);
    const compactCalls = httpReqMock.mock.calls.filter(
      (args: any[]) => args[0]?.path === "/compact",
    );
    expect(compactCalls.length).toBe(0);
  });

  it("fires promote after ingest (always)", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 100 });
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      client, 3737,
    );
    const httpReqMock = vi.mocked(request);
    const promoteCalls = httpReqMock.mock.calls.filter(
      (args: any[]) => args[0]?.path === "/promote",
    );
    expect(promoteCalls.length).toBe(1);
  });

  it("records session completion in ingest manifest", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 5, totalTokens: 100 });
    await handleSessionEnd(
      JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      client, 3737,
    );
    const httpReqMock = vi.mocked(request);
    const manifestCalls = httpReqMock.mock.calls.filter(
      (args: any[]) => args[0]?.path === "/session-complete",
    );
    expect(manifestCalls.length).toBe(1);
  });

  it("calls socket.unref() so the process does not wait for a compact response", async () => {
    // fireCompactRequest registers a "socket" handler that calls unref() — this is
    // what prevents the Node.js event loop from staying alive until the daemon responds.
    const mockSocket = { unref: vi.fn() };
    mockHttpReq.on.mockImplementation((event: string, cb: (s: unknown) => void) => {
      if (event === "socket") cb(mockSocket);
      if (event === "finish") cb(undefined);
      return mockHttpReq;
    });

    const client = createMockClient({ ingested: 100, totalTokens: 25000 });
    const input = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    const result = await handleSessionEnd(input, client, 3737);

    expect(result.exitCode).toBe(0);
    expect(mockSocket.unref).toHaveBeenCalled();
  });

  it("fires compact at exact threshold boundary (>=)", async () => {
    const { request } = await import("node:http");
    const client = createMockClient({ ingested: 50, totalTokens: 10000 });
    const input = JSON.stringify({ session_id: "s1", cwd: "/tmp" });
    await handleSessionEnd(input, client, 3737);
    expect(request).toHaveBeenCalled();
  });

  it("handles empty stdin gracefully", async () => {
    const client = createMockClient({ ingested: 0 });
    const result = await handleSessionEnd("", client, 3737);
    expect(result.exitCode).toBe(0);
  });
});

function stdin(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}
