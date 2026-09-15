import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import type { UncompactedConversation } from "../../../src/batch-compact.js";
import type { LcmPaths } from "../../../src/lcm-paths.js";

type Scan = (paths: LcmPaths, minTokens: number, cwd: string) => Promise<UncompactedConversation[]>;
const scan = vi.fn<Scan>();
vi.mock("../../../src/daemon/session-start-compact-worker.js", () => ({
  createSessionStartCompactScanner: () => ({
    scan: (...args: Parameters<Scan>) => scan(...args),
  }),
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
const { createLcmPaths } = await import("../../../src/lcm-paths.js");
const { lcmHome } = await import("../../../src/lcm-home.js");
const { validateCwd } = await import("../../../src/daemon/validate-cwd.js");

const paths = createLcmPaths(lcmHome());

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

/** The sweep runs after the response, on the next macrotask. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("POST /session-start-compact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-start-compact-"));
    scan.mockReset().mockResolvedValue([]);
    fireCompactRequest.mockClear();
    compactingSessionsFor.mockReset().mockReturnValue([]);
  });

  it("answers 400, not 500, on a malformed JSON body", async () => {
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, "not json");
    expect(out.status).toBe(400);
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("rejects an empty session_id, which would let the sweep queue the starting conversation", async () => {
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "   " }));
    expect(out.status).toBe(400);
    await settled();
    expect(scan).not.toHaveBeenCalled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid cwd", async () => {
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: "s1" }));
    expect(out.status).toBe(400);
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("fires nothing and reports queued: 0 when disableAutoCompact is set", async () => {
    const config = baseConfig();
    config.hooks.disableAutoCompact = true;
    const handler = createSessionStartCompactHandler(config, 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "s1" }));
    expect(out.body).toEqual({ queued: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("fires nothing and reports queued: 0 when the cap is 0", async () => {
    const handler = createSessionStartCompactHandler(baseConfig({ autoCompactSessionStartMax: 0 }), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "s1" }));
    expect(out.body).toEqual({ queued: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("excludes the starting session and fires the rest", async () => {
    scan.mockResolvedValue([
      conv({ sessionId: "starting-session", updatedAt: "2026-01-01T00:00:00Z" }),
      conv({ sessionId: "s-old", updatedAt: "2025-01-01T00:00:00Z" }),
    ]);
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting-session" }));
    expect(out.body).toEqual({ queued: "scheduled" });
    await settled();
    expect(fireCompactRequest).toHaveBeenCalledTimes(1);
    expect(fireCompactRequest).toHaveBeenCalledWith(4242, expect.objectContaining({ session_id: "s-old" }), paths);
  });

  it("skips a conversation already compacting", async () => {
    scan.mockResolvedValue([conv({ sessionId: "in-flight" })]);
    compactingSessionsFor.mockReturnValue(["in-flight"]);
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting" }));
    expect(out.body).toEqual({ queued: "scheduled" });
    await settled();
    expect(fireCompactRequest).not.toHaveBeenCalled();
  });

  it("caps the number fired and orders oldest first", async () => {
    scan.mockResolvedValue([
      conv({ sessionId: "newest", updatedAt: "2026-03-01T00:00:00Z" }),
      conv({ sessionId: "oldest", updatedAt: "2025-01-01T00:00:00Z" }),
      conv({ sessionId: "middle", updatedAt: "2025-06-01T00:00:00Z" }),
    ]);
    const handler = createSessionStartCompactHandler(baseConfig({ autoCompactMinTokens: 10000, autoCompactSessionStartMax: 2 }), 4242, paths);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting" }));
    expect(out.body).toEqual({ queued: "scheduled" });
    await settled();
    expect(fireCompactRequest).toHaveBeenCalledTimes(2);
    expect(fireCompactRequest).toHaveBeenNthCalledWith(1, 4242, expect.objectContaining({ session_id: "oldest" }), paths);
    expect(fireCompactRequest).toHaveBeenNthCalledWith(2, 4242, expect.objectContaining({ session_id: "middle" }), paths);
  });

  it("answers before the worker scan completes", async () => {
    let resolveScan!: (candidates: UncompactedConversation[]) => void;
    scan.mockReturnValue(new Promise((resolve) => { resolveScan = resolve; }));
    const handler = createSessionStartCompactHandler(baseConfig(), 4242, paths);
    const { res, out } = respond();

    await handler({} as never, res, JSON.stringify({ cwd: dir, session_id: "starting" }));

    expect(out.body).toEqual({ queued: "scheduled" });
    expect(scan).toHaveBeenCalledWith(paths, 10000, validateCwd(dir));
    expect(fireCompactRequest).not.toHaveBeenCalled();

    resolveScan([]);
    await settled();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
