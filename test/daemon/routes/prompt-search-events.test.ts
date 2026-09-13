import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventsDb } from "../../../src/hooks/events-db.js";
import { createPromptSearchHandler } from "../../../src/daemon/routes/prompt-search.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { createLcmPaths, type LcmPaths } from "../../../src/lcm-paths.js";
import { eventsDbPath } from "../../../src/db/events-path.js";

function respond() {
  const out = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body: string) => { out.body = JSON.parse(body); },
  } as unknown as Parameters<ReturnType<typeof createPromptSearchHandler>>[1];
  return { res, out };
}

describe("POST /prompt-search with recordEvents (function-hooks module path)", () => {
  let dir: string;
  let paths: LcmPaths;
  let handler: ReturnType<typeof createPromptSearchHandler>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-search-events-"));
    // The functions read only `paths.eventsDir`; pointing it straight at the temp
    // dir avoids also creating the sibling `events/` directory a real home would have.
    paths = { ...createLcmPaths(dir), eventsDir: dir };
    handler = createPromptSearchHandler(loadDaemonConfig(join(tmpdir(), "no-such-config.json")), paths);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records the prompt's events even when the project has no memory DB yet", async () => {
    const { res, out } = respond();
    await handler({} as never, res, JSON.stringify({
      query: "always use postgres for the migration", cwd: dir, session_id: "s1", recordEvents: true,
    }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ hints: [] });

    const db = new EventsDb(eventsDbPath(dir, paths));
    const rows = db.getUnprocessed();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.session_id === "s1" && r.source_hook === "UserPromptSubmit")).toBe(true);
  });

  it("writes nothing without recordEvents (the command hook's own path)", async () => {
    const { res } = respond();
    await handler({} as never, res, JSON.stringify({
      query: "always use postgres for the migration", cwd: dir, session_id: "s1",
    }));
    const { existsSync } = await import("node:fs");
    expect(existsSync(eventsDbPath(dir, paths))).toBe(false);
  });
});
