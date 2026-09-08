import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createToolEventHandler } from "../../../src/daemon/routes/tool-event.js";
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
  } as unknown as Parameters<ReturnType<typeof createToolEventHandler>>[1];
  return { res, out };
}

describe("POST /tool-event", () => {
  let dir: string;
  const handler = createToolEventHandler({} as DaemonConfig);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-event-"));
    process.env.TEST_EVENTS_DIR = dir;
    promoteEvents.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_EVENTS_DIR;
  });

  it("rejects a body without session_id, tool_name or cwd", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ tool_name: "Bash", cwd: dir }));
    expect(out.status).toBe(400);
  });

  it("answers 400 on a malformed JSON body instead of throwing", async () => {
    const { res, out } = respond();
    await handler({} as never, res, "{not json");
    expect(out.status).toBe(400);
  });

  it("rejects a non-string session_id", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: 42, tool_name: "Bash", cwd: dir }));
    expect(out.status).toBe(400);
  });

  it("rejects a non-string cwd", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({ session_id: "s1", tool_name: "Bash", cwd: { path: dir } }));
    expect(out.status).toBe(400);
  });

  it("writes the same event row the PostToolUse command hook writes", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({
      session_id: "s1", cwd: dir, tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" },
    }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ recorded: 1, promoted: false });

    const db = new EventsDb(join(dir, "events.db"));
    const rows = db.getUnprocessed();
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "s1", type: "file_read", source_hook: "PostToolUse" });
    expect(promoteEvents).not.toHaveBeenCalled();
  });

  it("labels a failed call PostToolUseFailure and promotes it at once", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({
      session_id: "s1", cwd: dir, tool_name: "Bash", tool_input: { command: "npm test" },
      hook_event_name: "PostToolUseFailure", error: "Exit code 1\nfailing test", tool_output: { isError: true },
    }));
    expect(out.body).toEqual({ recorded: 1, promoted: true });

    const db = new EventsDb(join(dir, "events.db"));
    const [row] = db.getUnprocessed();
    db.close();
    expect(row).toMatchObject({ type: "error_tool", priority: 1, source_hook: "PostToolUseFailure" });
    await vi.waitFor(() => expect(promoteEvents).toHaveBeenCalledTimes(1));
    expect(JSON.parse(promoteEvents.mock.calls[0][2])).toMatchObject({ cwd: expect.stringContaining("tool-event-") });
  });
});
