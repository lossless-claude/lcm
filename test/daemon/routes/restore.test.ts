import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath } from "../../../src/daemon/project.js";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { lcmHome } from "../../../src/lcm-home.js";
import { createLcmPaths } from "../../../src/lcm-paths.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";

/**
 * The wire contract of POST /restore, which is the whole of `routes/restore.ts`: how a
 * request maps onto the restore module's outcome, and how that outcome maps onto a status
 * and a body. What the context is assembled from is tested at the module's own seam.
 */
const paths = createLcmPaths(lcmHome());

describe("POST /restore", () => {
  let daemon: DaemonInstance | undefined;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "restore-wire-test-"));
    daemon = await createDaemon(loadDaemonConfig(tmpDir, { daemon: { port: 0 } }));
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(rawBody: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${daemon!.address().port}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("answers the assembled context, omitting insights when there are none", async () => {
    const { status, body } = await post(JSON.stringify({ session_id: "wire-sess", cwd: tmpDir }));
    expect(status).toBe(200);
    expect(body.context).toBe("");
    expect(body.insights).toBeUndefined();
  });

  it("carries insights that ride along with the context", async () => {
    const dbPath = projectDbPath(tmpDir, paths);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      runLcmMigrations(db);
      new PromotedStore(db).insert({
        content: "Passive insight that the wire must carry",
        tags: ["source:passive-capture"],
        projectId: tmpDir,
        confidence: 0.9,
      });
    } finally {
      db.close();
    }

    const { status, body } = await post(JSON.stringify({ session_id: "wire-session", cwd: tmpDir }));
    expect(status).toBe(200);
    expect(body.insights).toEqual([
      expect.objectContaining({ content: "Passive insight that the wire must carry", confidence: 0.9 }),
    ]);
  });

  it("answers 400 for a cwd that is not a usable project directory", async () => {
    const { status, body } = await post(JSON.stringify({ session_id: "wire-sess", cwd: "relative/path" }));
    expect(status).toBe(400);
    expect(body.error).toBe("cwd must be an absolute path");
  });

  it("answers 500 for a body that is not JSON", async () => {
    const { status, body } = await post("not json");
    expect(status).toBe(500);
    expect(body.error).toBeDefined();
  });
});