import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DaemonConfig } from "../../../src/daemon/config.js";
import type { RouteHandler } from "../../../src/daemon/server.js";

const fired = {
  compact: vi.fn(),
  promote: vi.fn(),
  promoteEvents: vi.fn(),
  sessionComplete: vi.fn(),
};
vi.mock("../../../src/hooks/session-end.js", () => ({
  fireCompactRequest: (...args: unknown[]) => fired.compact(...args),
  firePromoteRequest: (...args: unknown[]) => fired.promote(...args),
  firePromoteEventsRequest: (...args: unknown[]) => fired.promoteEvents(...args),
  fireSessionCompleteRequest: (...args: unknown[]) => fired.sessionComplete(...args),
}));

const safeLogError = vi.fn();
vi.mock("../../../src/hooks/hook-errors.js", () => ({
  safeLogError: (...args: unknown[]) => safeLogError(...args),
}));

const { createSessionEndHandler, invokeRoute } = await import("../../../src/daemon/routes/session-end.js");
const { createLcmPaths } = await import("../../../src/lcm-paths.js");
const { lcmHome } = await import("../../../src/lcm-home.js");

const paths = createLcmPaths(lcmHome());
const PORT = 4242;

function respond() {
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = JSON.parse(body); },
  } as unknown as Parameters<RouteHandler>[1];
  return { res, out };
}

function config(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return { compaction: {}, hooks: {}, ...overrides } as unknown as DaemonConfig;
}

/**
 * An ingest route that records its body and answers a fixed result, once
 * `release()` is called (immediately unless `held`).
 */
function ingestStub(result: Record<string, unknown>, opts: { status?: number; held?: boolean } = {}) {
  const bodies: string[] = [];
  let release = () => {};
  const gate = opts.held ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const handler: RouteHandler = async (_req, res, body) => {
    bodies.push(body);
    await gate;
    res.writeHead(opts.status ?? 200);
    res.end(JSON.stringify(result));
  };
  return { handler, bodies, release: () => release() };
}

/** The sequence runs after the response, on later macrotasks. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("POST /session-end", () => {
  let dir: string;

  beforeEach(() => {
    // validateCwd hands the daemon the real path, which is what the fired requests carry.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "session-end-")));
    for (const fn of Object.values(fired)) fn.mockClear();
    safeLogError.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers 400 on a malformed body, a blank session_id and a missing cwd", async () => {
    const ingest = ingestStub({ ingested: 1 });
    const handler = createSessionEndHandler(config(), PORT, paths, ingest.handler);
    for (const body of ["not json", JSON.stringify({ cwd: dir, session_id: " " }), JSON.stringify({ session_id: "s1" })]) {
      const { res, out } = respond();
      await handler({} as never, res, body);
      expect(out.status, body).toBe(400);
    }
    await settled();
    expect(ingest.bodies).toEqual([]);
    expect(fired.compact).not.toHaveBeenCalled();
  });

  it("answers 202 while the ingest is still running", async () => {
    const ingest = ingestStub({ ingested: 3 }, { held: true });
    const handler = createSessionEndHandler(config(), PORT, paths, ingest.handler);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: "s1", cwd: dir }));
    expect(out.status).toBe(202);
    expect(ingest.bodies).toHaveLength(1);
    expect(fired.sessionComplete).not.toHaveBeenCalled();
    ingest.release();
    await settled();
    expect(fired.sessionComplete).toHaveBeenCalledTimes(1);
  });

  it("fires nothing when ingest answers a non-2xx status, and logs it", async () => {
    const ingest = ingestStub({ error: "bad transcript" }, { status: 400 });
    const handler = createSessionEndHandler(config(), PORT, paths, ingest.handler);
    await handler({} as never, respond().res, JSON.stringify({ session_id: "s1", cwd: dir }));
    await settled();
    expect(fired.compact).not.toHaveBeenCalled();
    expect(fired.sessionComplete).not.toHaveBeenCalled();
    expect(safeLogError).toHaveBeenCalledWith(
      "session-end",
      expect.objectContaining({ message: expect.stringContaining("HTTP 400") }),
      expect.objectContaining({ sessionId: "s1" }),
    );
  });

  it("hands ingest the validated identity, then fires compact, promote, promote-events and session-complete", async () => {
    const ingest = ingestStub({ ingested: 7 });
    const handler = createSessionEndHandler(config(), PORT, paths, ingest.handler);
    // Padded id and an unresolved (non-real) path: ingest must see what the follow-ups see.
    const body = { session_id: " s1 ", cwd: join(dir, ".", "."), transcript_path: join(dir, "t.jsonl") };
    await handler({} as never, respond().res, JSON.stringify(body));
    await settled();

    expect(ingest.bodies.map((b) => JSON.parse(b))).toEqual([{ ...body, session_id: "s1", cwd: dir }]);
    expect(fired.compact).toHaveBeenCalledWith(PORT, { session_id: "s1", cwd: dir, skip_ingest: true, client: "claude" }, paths);
    expect(fired.promote).toHaveBeenCalledWith(PORT, { cwd: dir }, paths);
    expect(fired.promoteEvents).toHaveBeenCalledWith(PORT, { cwd: dir }, paths);
    expect(fired.sessionComplete).toHaveBeenCalledWith(PORT, { session_id: "s1", cwd: dir, message_count: 7 }, paths);
  });

  it("skips compact when hooks.disableAutoCompact is set, and still records completion", async () => {
    const ingest = ingestStub({ ingested: 2 });
    const handler = createSessionEndHandler(config({ hooks: { disableAutoCompact: true } } as never), PORT, paths, ingest.handler);
    await handler({} as never, respond().res, JSON.stringify({ session_id: "s1", cwd: dir }));
    await settled();
    expect(fired.compact).not.toHaveBeenCalled();
    expect(fired.sessionComplete).toHaveBeenCalledTimes(1);
  });

  it("fires nothing after a failed ingest and logs the error", async () => {
    const failing: RouteHandler = async () => { throw new Error("boom"); };
    const handler = createSessionEndHandler(config(), PORT, paths, failing);
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: "s1", cwd: dir }));
    expect(out.status).toBe(202);
    await settled();
    expect(fired.compact).not.toHaveBeenCalled();
    expect(fired.sessionComplete).not.toHaveBeenCalled();
    expect(safeLogError).toHaveBeenCalledWith("session-end", expect.objectContaining({ message: "boom" }), expect.objectContaining({ sessionId: "s1" }));
  });

  it("logs a redaction notice unless notify_on_filter is false", async () => {
    const ingest = ingestStub({ ingested: 1, redacted: 1, redactedCategories: ["gitleaks"] });
    const body = JSON.stringify({ session_id: "s1", cwd: dir });

    await createSessionEndHandler(config(), PORT, paths, ingest.handler)({} as never, respond().res, body);
    await settled();
    expect(safeLogError).toHaveBeenCalledWith("session-end:redaction-notice", expect.stringContaining("pattern: gitleaks"), expect.objectContaining({ sessionId: "s1" }));

    safeLogError.mockClear();
    const muted = config({ security: { notify_on_filter: false } } as never);
    await createSessionEndHandler(muted, PORT, paths, ingest.handler)({} as never, respond().res, body);
    await settled();
    expect(safeLogError).not.toHaveBeenCalled();
  });
});

describe("invokeRoute", () => {
  it("returns the handler's JSON body", async () => {
    const ingest = ingestStub({ ingested: 4, totalTokens: 40 });
    await expect(invokeRoute(ingest.handler, { a: 1 })).resolves.toEqual({ ingested: 4, totalTokens: 40 });
    expect(ingest.bodies).toEqual([JSON.stringify({ a: 1 })]);
  });

  it("rejects on a non-2xx status like DaemonClient.post does", async () => {
    const ingest = ingestStub({ error: "nope" }, { status: 500 });
    await expect(invokeRoute(ingest.handler, {})).rejects.toThrow("HTTP 500");
  });
});
