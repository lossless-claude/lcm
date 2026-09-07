import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";
import { projectDbPath, projectDir } from "../../../src/daemon/project.js";
import { runLcmMigrations } from "../../../src/db/migration.js";
import { PromotedStore } from "../../../src/db/promoted.js";
import type { QmdClient } from "../../../src/search/qmd-client.js";

let daemon: DaemonInstance;
let cwd: string;
let qmd: QmdClient;
beforeEach(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "lcm-qmd-route-")));
  qmd = { index: vi.fn(), search: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  daemon = await createDaemon(loadDaemonConfig("/nonexistent", { daemon: { port: 0 } }), { qmd });
});
afterEach(async () => {
  await daemon.stop();
  expect(qmd.close).toHaveBeenCalledOnce();
  rmSync(projectDir(cwd), { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
function post(path: string, body: unknown) {
  return fetch(`http://127.0.0.1:${daemon.address().port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
it("indexes only when explicitly requested and never embeds by default", async () => {
  vi.mocked(qmd.index).mockResolvedValue({ documents: 2 } as Awaited<ReturnType<QmdClient["index"]>>);
  expect((await post("/search/index", { cwd })).status).toBe(200);
  expect(qmd.index).toHaveBeenCalledWith({ cwd, embed: false });
  expect((await post("/search/index", { cwd, embed: "yes" })).status).toBe(400);
  expect((await post("/search/index", { cwd, timeoutMs: -1 })).status).toBe(400);
  expect(qmd.index).toHaveBeenCalledOnce();
  await post("/search/index", { cwd, embed: true, timeoutMs: 3_600_000 });
  expect(qmd.index).toHaveBeenLastCalledWith({ cwd, embed: true, timeoutMs: 3_600_000 });
});
it("validates QMD requests before invoking models and returns the unified ranking", async () => {
  vi.mocked(qmd.search).mockResolvedValue({ matches: [{ ref: "evidence" }] } as Awaited<ReturnType<QmdClient["search"]>>);
  expect((await post("/search", { cwd, query: "decision", backend: "qmd", mode: "unknown" })).status).toBe(400);
  expect(qmd.search).not.toHaveBeenCalled();
  const response = await post("/search", { cwd, query: "decision", backend: "qmd" });
  expect(await response.json()).toMatchObject({ backend: "qmd", matches: [{ ref: "evidence" }] });
  expect(qmd.search).toHaveBeenCalledWith(expect.objectContaining({ cwd, mode: "lexical", limit: 5 }));
});
it("falls back to real native retrieval with an explicit QMD error", async () => {
  mkdirSync(projectDir(cwd), { recursive: true });
  const db = new DatabaseSync(projectDbPath(cwd));
  runLcmMigrations(db);
  new PromotedStore(db).insert({ content: "Azulejo storage decision", tags: [], projectId: "manual", sessionId: "manual", confidence: 1, depth: 0 });
  db.close();
  vi.mocked(qmd.search).mockRejectedValue(new Error("QMD index is not ready. Run lcm index first."));
  const response = await post("/search", { cwd, query: "Azulejo", backend: "qmd" });
  const body = await response.json();
  expect(body).toMatchObject({ backend: "native", fallback: true });
  expect(body.promoted[0].content).toContain("Azulejo");
  expect(body.errors[0]).toContain("Run lcm index");
});
