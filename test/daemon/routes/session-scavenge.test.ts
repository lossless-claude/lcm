import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createSessionScavengeHandler } from "../../../src/daemon/routes/session-scavenge.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

vi.mock("../../../src/db/events-path.js", () => ({
  eventsDbPath: () => join(process.env.TEST_EVENTS_DIR!, "events.db"),
  eventsDir: () => process.env.TEST_EVENTS_DIR!,
}));

const promoteEvents = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/daemon/routes/promote-events.js", () => ({
  createPromoteEventsHandler: () => promoteEvents,
}));

function respond() {
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = JSON.parse(body); },
  } as unknown as Parameters<ReturnType<typeof createSessionScavengeHandler>>[1];
  return { res, out };
}

/** Lets the in-process promote-events call scheduled after the response run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("POST /session-scavenge", () => {
  let dir: string;
  const handler = createSessionScavengeHandler({} as DaemonConfig);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-scavenge-"));
    process.env.TEST_EVENTS_DIR = dir;
    promoteEvents.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("rejects a malformed body", async () => {
    const { res, out } = respond();
    await handler({} as never, res, "{ not json");
    expect(out.status).toBe(400);
  });

  it("rejects a body without cwd", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({}));
    expect(out.status).toBe(400);
  });

  it("rejects a non-string cwd", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: { path: dir } }));
    expect(out.status).toBe(400);
  });

  it("prunes and promotes when unprocessed events are waiting", async () => {
    const db = new EventsDb(join(dir, "events.db"));
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    db.close();

    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ pruned: true, promoted: true });
    await flush();
    expect(promoteEvents).toHaveBeenCalled();
  });

  it("prunes without promoting when nothing is waiting", async () => {
    new EventsDb(join(dir, "events.db")).close();

    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir }));
    expect(out.body).toEqual({ pruned: true, promoted: false });
    await flush();
    expect(promoteEvents).not.toHaveBeenCalled();
  });

  it("drops processed events past the retention window", async () => {
    const db = new EventsDb(join(dir, "events.db"));
    db.insertEvent("s1", { type: "a", category: "file", data: "x", priority: 3 }, "PostToolUse");
    const [event] = db.getUnprocessed();
    db.markProcessed([event.event_id]);
    db.raw().exec(
      `UPDATE events SET processed_at = datetime('now', '-30 days') WHERE event_id = ${event.event_id}`,
    );
    db.close();

    const { res } = respond();
    await handler({} as never, res, JSON.stringify({ cwd: dir }));

    const after = new EventsDb(join(dir, "events.db"));
    const rows = after.raw().prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    after.close();
    expect(rows.c).toBe(0);
  });
});
