import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import { projectDbPath, projectId } from "../../../src/daemon/project.js";

/**
 * A result that does not say which project it came from cannot be followed up
 * on once several projects share one list: `conversation_id` and `message_id`
 * are AUTOINCREMENT per database, so the same id names a different row in each.
 */

const tempDirs: string[] = [];
let daemon: DaemonInstance | undefined;

afterEach(async () => {
  if (daemon) { await daemon.stop(); daemon = undefined; }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lcm-scoped-")));
  tempDirs.push(dir);
  const dbPath = projectDbPath(dir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db);
  new PromotedStore(db).insert({
    content: "We decided to union memory at read time",
    tags: ["decision"],
    projectId: "p1",
  });
  db.close();
  return dir;
}

async function start(): Promise<number> {
  const config = loadDaemonConfig("/nonexistent");
  config.daemon.port = 0;
  daemon = await createDaemon(config);
  return daemon.address().port;
}

const post = (port: number, route: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(res => res.json() as Promise<Record<string, any>>);

describe("results carry the project they came from", () => {
  it("names the project on every promoted hit", async () => {
    const cwd = makeProject();
    const port = await start();
    const data = await post(port, "search", { query: "union", cwd });
    expect(data.promoted.length).toBeGreaterThan(0);
    for (const hit of data.promoted) {
      expect(hit.project).toEqual({ id: projectId(cwd), cwd });
    }
  });
});

describe("a node id is resolved against the project that produced it", () => {
  it("expands a node named with this project's own id", async () => {
    const cwd = makeProject();
    const port = await start();
    const data = await post(port, "expand", { nodeId: "sum_missing", cwd, projectId: projectId(cwd) });
    expect(data.error).not.toBe("project not in group");
  });

  it("refuses to expand a node from a project outside the group", async () => {
    const cwd = makeProject();
    const stranger = makeProject();
    const port = await start();
    const data = await post(port, "expand", { nodeId: "sum_1", cwd, projectId: projectId(stranger) });
    expect(data).toEqual({ expanded: null, error: "project not in group" });
  });

  it("refuses to describe a node from a project outside the group", async () => {
    const cwd = makeProject();
    const stranger = makeProject();
    const port = await start();
    const data = await post(port, "describe", { nodeId: "sum_1", cwd, projectId: projectId(stranger) });
    expect(data).toEqual({ node: null, error: "project not in group" });
  });
});
