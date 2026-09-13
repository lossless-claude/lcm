import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import type { UncompactedConversation } from "../../../src/batch-compact.js";

const findUncompacted = vi.fn<[], UncompactedConversation[]>();
vi.mock("../../../src/batch-compact.js", () => ({
  findUncompacted: (...args: unknown[]) => findUncompacted(...(args as [])),
}));

const fireCompactRequest = vi.fn();
vi.mock("../../../src/hooks/session-end.js", () => ({
  fireCompactRequest: (...args: unknown[]) => fireCompactRequest(...args),
}));

const compactingSessionsFor = vi.fn().mockReturnValue([] as string[]);
vi.mock("../../../src/daemon/routes/compact.js", () => ({
  compactingSessionsFor: (...args: unknown[]) => compactingSessionsFor(...args),
}));

const { createSessionStartCompactHandler } = await import("../../../src/daemon/routes/session-start-compact.js");

function conv(overrides: Partial<UncompactedConversation>): UncompactedConversation {
  return {
    projectDir: "/proj-dir",
    cwd: "/proj",
    conversationId: 1,
    sessionId: "s-default",
    messages: 10,
    tokens: 20000,
    sourceMessages: 10,
    sourceTokens: 20000,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function respond() {
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = JSON.parse(body); },
  } as unknown as Parameters<ReturnType<typeof createSessionStartCompactHandler>>[1];
  return { res, out };
}

function baseConfig(overrides?: Partial<DaemonConfig["compaction"]>): DaemonConfig {
  return {
    compaction: { autoCompactMinTokens: 10000, autoCompactSessionStartMax: 2, ...overrides },
    hooks: { snapshotIntervalSec: 60, disableAutoCompact: false },
  } as unknown as DaemonConfig;
}

describe("POST /session-start-compact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-start-compact-"));
    findUncompacted.mockReset();
    fireCompactRequest.mockClear();
    compactingSessionsFor.mockReset().mockReturnValue([]);
  });

  it("rejects a missing or invalid cwd", async () => {
    const handler = createSessionStartCompactHandler(baseConfig(), 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: "s1" }));
    expect(out.status).toBe(400);
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("fires nothing and reports queued: 0 when disableAutoCompact is set", async () => {
    findUncompacted.mockReturnValue([conv({ sessionId: "s2" })]);
    const config = baseConfig();
    config.hooks.disableAutoCompact = true;
    const handler = createSessionStartCompactHandler(config, 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "s1" }));
    expect(out.body).toEqual({ queued: 0 });
    expect(findUncompacted).not.toHaveBeenCalled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("fires nothing and reports queued: 0 when the cap is 0", async () => {
    findUncompacted.mockReturnValue([conv({ sessionId: "s2" })]);
    const handler = createSessionStartCompactHandler(baseConfig({ autoCompactSessionStartMax: 0 }), 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "s1" }));
    expect(out.body).toEqual({ queued: 0 });
    expect(findUncompacted).not.toHaveBeenCalled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("excludes the starting session and fires the rest", async () => {
    findUncompacted.mockReturnValue([
      conv({ sessionId: "starting-session", updatedAt: "2026-01-01T00:00:00Z" }),
      conv({ sessionId: "s-old", updatedAt: "2025-01-01T00:00:00Z" }),
    ]);
    const handler = createSessionStartCompactHandler(baseConfig(), 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting-session" }));
    expect(out.body).toEqual({ queued: 1 });
    expect(fireCompactRequest).toHaveBeenCalledTimes(1);
    expect(fireCompactRequest).toHaveBeenCalledWith(4242, expect.objectContaining({ session_id: "s-old" }));
  });

  it("skips a conversation already compacting", async () => {
    findUncompacted.mockReturnValue([conv({ sessionId: "in-flight" })]);
    compactingSessionsFor.mockReturnValue(["in-flight"]);
    const handler = createSessionStartCompactHandler(baseConfig(), 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting" }));
    expect(out.body).toEqual({ queued: 0 });
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("caps the number fired and orders oldest first", async () => {
    findUncompacted.mockReturnValue([
      conv({ sessionId: "newest", updatedAt: "2026-03-01T00:00:00Z" }),
      conv({ sessionId: "oldest", updatedAt: "2025-01-01T00:00:00Z" }),
      conv({ sessionId: "middle", updatedAt: "2025-06-01T00:00:00Z" }),
    ]);
    const handler = createSessionStartCompactHandler(baseConfig({ autoCompactMinTokens: 10000, autoCompactSessionStartMax: 2 }), 4242);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting" }));
    expect(out.body).toEqual({ queued: 2 });
    expect(fireCompactRequest).toHaveBeenCalledTimes(2);
    expect(fireCompactRequest).toHaveBeenNthCalledWith(1, 4242, expect.objectContaining({ session_id: "oldest" }));
    expect(fireCompactRequest).toHaveBeenNthCalledWith(2, 4242, expect.objectContaining({ session_id: "middle" }));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
