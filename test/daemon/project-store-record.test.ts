import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { lcmHome } from "../../src/lcm-home.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { readProjectMeta } from "../../src/daemon/project-meta.js";
import { projectDbPath, projectId } from "../../src/daemon/project.js";
import { EventsDb } from "../../src/hooks/events-db.js";
import { eventsDbPath } from "../../src/db/events-path.js";
import { createPromoteEventsHandler } from "../../src/daemon/routes/promote-events.js";
import { createRestore } from "../../src/daemon/restore/index.js";
import { importKnowledge, type ExportDocument } from "../../src/portable-knowledge.js";
import { createPromoteHandler } from "../../src/daemon/routes/promote.js";
import { createStoreHandler } from "../../src/daemon/routes/store.js";
import { DatabaseSync } from "node:sqlite";
import { PromotedStore } from "../../src/db/promoted.js";

const paths = createLcmPaths(lcmHome());
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function checkout(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lcm-store-record-")));
  dirs.push(dir);
  return dir;
}

function response() {
  let body = "";
  const res = { writeHead: vi.fn(), end: (text: string) => { body = text; } };
  return { res: res as unknown as ServerResponse, body: () => JSON.parse(body) };
}

it("passive event promotion creates the project record with its first store", async () => {
  const cwd = checkout();
  const events = new EventsDb(eventsDbPath(cwd, paths));
  events.insertEvent("session", { type: "error_tool", category: "error", data: "Bash error: fixture failure", priority: 1 }, "PostToolUse");
  events.close();
  const result = response();
  await createPromoteEventsHandler(loadDaemonConfig("/nonexistent"), paths)({} as never, result.res, JSON.stringify({ cwd }));
  expect(result.body().promoted).toBe(1);
  expect(existsSync(projectDbPath(cwd, paths))).toBe(true);
  expect(readProjectMeta(cwd, paths)?.cwd).toBe(cwd);
});

it("a first restore records the cwd of the store it creates", async () => {
  const cwd = checkout();
  const restore = createRestore(loadDaemonConfig("/nonexistent"), paths);
  expect((await restore({ cwd, sessionId: "new-session", source: "startup" })).kind).toBe("context");
  expect(existsSync(projectDbPath(cwd, paths))).toBe(true);
  expect(readProjectMeta(cwd, paths)?.cwd).toBe(cwd);
});

it("portable import records its cwd before processing the first memory", async () => {
  const cwd = checkout();
  let recordedCwd: string | undefined;
  const doc: ExportDocument = {
    version: 1, exportedAt: "2026-01-01T00:00:00Z", projectCwd: "/original-checkout",
    entries: [{
      get content() { recordedCwd = readProjectMeta(cwd, paths)?.cwd; return "Use SQLite for local memory"; },
      tags: ["type:decision"], confidence: 1, createdAt: "2026-01-01T00:00:00Z", sessionId: null,
    }],
  };
  expect((await importKnowledge(cwd, paths, doc)).imported).toBe(1);
  expect(recordedCwd).toBe(cwd);
});

it("summary promotion records an existing record-less store even when opening it fails", async () => {
  const cwd = checkout();
  mkdirSync(dirname(projectDbPath(cwd, paths)), { recursive: true });
  writeFileSync(projectDbPath(cwd, paths), "invalid database");
  const result = response();
  await createPromoteHandler(loadDaemonConfig("/nonexistent"), paths)({} as never, result.res, JSON.stringify({ cwd }));
  expect(result.res.writeHead).toHaveBeenCalledWith(500, expect.anything());
  expect(readProjectMeta(cwd, paths)?.cwd).toBe(cwd);
});

it("store uses the supplied cwd's canonical store and record while honoring projectId provenance", async () => {
  const cwd = checkout();
  const alias = join(cwd, "alias");
  symlinkSync(cwd, alias);
  const provenance = "e".repeat(64);
  const result = response();
  await createStoreHandler(loadDaemonConfig("/nonexistent"), paths)({} as never, result.res, JSON.stringify({
    cwd: alias, text: "Explicitly attributed memory", metadata: { projectId: provenance },
  }));
  expect(result.body().stored).toBe(true);
  expect(readProjectMeta(cwd, paths)?.cwd).toBe(cwd);
  expect(existsSync(join(paths.projectsDir, provenance))).toBe(false);
  expect(projectId(alias)).toBe(projectId(cwd));
  const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
  try { expect(new PromotedStore(db).getById(result.body().id)?.project_id).toBe(provenance); }
  finally { db.close(); }
});

it("a summary promotion dry run leaves a missing project record untouched", async () => {
  const cwd = checkout();
  mkdirSync(dirname(projectDbPath(cwd, paths)), { recursive: true });
  writeFileSync(projectDbPath(cwd, paths), "invalid database");
  const result = response();
  await createPromoteHandler(loadDaemonConfig("/nonexistent"), paths)({} as never, result.res, JSON.stringify({ cwd, dry_run: true }));
  expect(readProjectMeta(cwd, paths)).toBeNull();
});
