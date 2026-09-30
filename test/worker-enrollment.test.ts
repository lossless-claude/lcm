import { createIngestHandler } from "../src/daemon/routes/ingest.js";
import { acquireProjectMutation } from "../src/daemon/project-queue.js";
import { projectId } from "../src/daemon/project.js";
import { collectStats } from "../src/stats.js";
import { createStatusHandler } from "../src/daemon/routes/status.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { invokeRoute } from "../src/daemon/routes/session-end.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLcmPaths } from "../src/lcm-paths.js";
import { registerWorkerSession } from "../src/worker-session.js";
import { recordPostToolEvents } from "../src/hooks/tool-events.js";
import { EventsDb } from "../src/hooks/events-db.js";
import { eventsDbPath } from "../src/db/events-path.js";
import { getLcmConnection, closeLcmConnection } from "../src/db/connection.js";
import { projectDbPath } from "../src/daemon/project.js";
import { WorkerStore } from "../src/store/worker-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
it("registration removes sidecar canaries, gates later calls, and persists after reopening", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-test-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const event = { session_id: "worker", cwd, tool_name: "Bash", tool_input: { command: "git commit -m FOREIGN_CANARY_685" } };
  expect(recordPostToolEvents(event, paths).recorded).toBeGreaterThan(0);
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" });
  expect(recordPostToolEvents(event, paths).recorded).toBe(0);
  const edb = new EventsDb(eventsDbPath(cwd, paths));
  expect(edb.getUnprocessed()).toEqual([]); edb.close();
  const dbPath = projectDbPath(cwd, paths);
  const db = getLcmConnection(dbPath);
  expect(new WorkerStore(db).live("worker", cwd, "claude")).toBe(true);
  closeLcmConnection(dbPath);
  const reopened = getLcmConnection(dbPath);
  expect(new WorkerStore(reopened).excluded("worker")).toBe(true);
  closeLcmConnection(dbPath);
});

it("reports durable enrollment and last activity even when the excluded project has no messages", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-status-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  await registerWorkerSession(paths, { sessionId: "worker", cwd, client: "codex", owner: "hook" });
  const stats = collectStats(paths);
  expect(stats.workers).toEqual([expect.objectContaining({ session_id: "worker", state: "active", last_activity: expect.any(String) })]);
  const status = await invokeRoute<{ project: { workers: unknown[]; workerWarning: string } }>(
    createStatusHandler(loadDaemonConfig("/nonexistent", {}, {}), paths, Date.now()), { cwd });
  expect(status.project.workers).toHaveLength(1);
  expect(status.project.workerWarning).toContain("transcript stays on disk");
});

it("a capture racing registration cannot write a foreign-content canary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-worker-race-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "lcm"));
  const lease = await acquireProjectMutation(projectId(cwd));
  const registration = registerWorkerSession(paths, { sessionId: "worker", cwd, client: "claude", owner: "hook" });
  const ingest = invokeRoute(createIngestHandler(loadDaemonConfig("/nonexistent", {}, {}), paths), {
    cwd, session_id: "worker", messages: [{ role: "user", content: "FOREIGN_RACING_CANARY_685", tokenCount: 10 }],
  });
  lease.release();
  await registration; await ingest;
  const path = projectDbPath(cwd, paths); const db = getLcmConnection(path);
  try {
    expect(db.prepare("SELECT * FROM messages").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM messages_fts").all()).toEqual([]);
  } finally { closeLcmConnection(path); }
});
