import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { projectDbPath, ensureProjectDir } from "../../src/daemon/project.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createTimelineHandler } from "../../src/daemon/routes/timeline.js";
import { createStatusHandler } from "../../src/daemon/routes/status.js";
import { createDescribeHandler } from "../../src/daemon/routes/describe.js";
import { createPromoteHandler } from "../../src/daemon/routes/promote.js";
import { invokeRoute } from "../../src/daemon/routes/session-end.js";
import { collectStats } from "../../src/stats.js";
import type { SettleReport } from "../../src/project-timeline.js";
import { updateProjectMeta } from "../../src/daemon/project-meta.js";
import { createReplayResetHandler } from "../../src/daemon/routes/replay-reset.js";
import { enableTimeline, TIMELINE_SESSION_ID } from "../../src/db/project-timeline.js";
import { createDaemon } from "../../src/daemon/server.js";
import * as summarizers from "../../src/daemon/summarizer.js";
import * as migrations from "../../src/db/migration.js";

const dirs: string[] = [];

it("a SQLITE_BUSY timeline read does not zero ordinary status counts", async () => {
  const { cwd, paths, config } = fixture();
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'Source', 1); INSERT INTO promoted(id, content, project_id) VALUES ('memory', 'Claim', 'project')");
  db.close();
  const original = DatabaseSync.prototype.prepare;
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    if (sql.includes("FROM timeline_units")) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return original.call(this, sql);
  });
  try {
    const status = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(status.project).toMatchObject({ messageCount: 1, summaryCount: 1, promotedCount: 1 });
  } finally { prepare.mockRestore(); }
});

it("status performs no migration or settle and preserves counts when the timeline query fails", async () => {
  const { cwd, paths, config } = fixture();
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('ordinary', 1, 'leaf', 'Source', 1); INSERT INTO promoted(id, content, project_id) VALUES ('memory', 'Claim', 'project')");
  const before = db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get();
  db.close();
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  try {
    const status = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(status.project).toMatchObject({ messageCount: 1, summaryCount: 1, promotedCount: 1, timeline: { dirty: 1, stale: 0 } });
    expect(migrate.mock.calls.length).toBe(0);
    const check = new DatabaseSync(projectDbPath(cwd, paths));
    expect(check.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get()).toEqual(before);
    expect(check.prepare("SELECT 1 FROM conversations WHERE is_timeline = 1").get()).toBeUndefined();
    check.exec("ALTER TABLE timeline_units RENAME TO broken_checkpoint");
    check.close();
    const failed = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(failed.project).toMatchObject({ messageCount: 1, summaryCount: 1, promotedCount: 1 });
  } finally { migrate.mockRestore(); }
});
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "lcm-timeline-route-")); dirs.push(cwd);
  const paths = createLcmPaths(join(cwd, "memory"));
  ensureProjectDir(cwd, paths);
  updateProjectMeta(cwd, paths, { cwd });
  const db = new DatabaseSync(projectDbPath(cwd, paths)); runLcmMigrations(db); enableTimeline(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('session'); INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at) VALUES (1, 0, 'user', 'We chose SQLite.', 10, '2026-08-01T00:00:00Z')");
  db.close();
  const config = loadDaemonConfig(paths.configPath, { summarizer: { mock: true }, timeline: { generationEnabled: true } });
  return { cwd, paths, config };
}

it("timeline, status and describe routes expose generation and model-free coverage", async () => {
  const { cwd, paths, config } = fixture();
  const timeline = createTimelineHandler(config, paths);
  expect(await invokeRoute<SettleReport>(timeline, { cwd, calls: 0 })).toMatchObject({ calls: 0, generated: 0, pending: 1 });
  expect(await invokeRoute<SettleReport>(timeline, { cwd, calls: 10 })).toMatchObject({ generated: 2, pending: 0, stopped: "complete" });
  const status = await invokeRoute<{ project: { summaryCount: number; timeline: SettleReport } }>(createStatusHandler(config, paths, Date.now()), { cwd });
  expect(status.project).toMatchObject({ summaryCount: 0, timeline: { calls: 0, pending: 0, stale: 0 } });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  const node = db.prepare("SELECT summary_id FROM timeline_nodes WHERE level = 'period'").get() as { summary_id: string }; db.close();
  const described = await invokeRoute<{ node: { timeline: { coverage: unknown[] } } }>(createDescribeHandler(config, paths), { cwd, nodeId: node.summary_id });
  expect(described.node.timeline.coverage).toMatchObject([{ sessionId: "session", messageRange: [0, 0] }]);
  expect(await invokeRoute(createPromoteHandler(config, paths), { cwd })).toMatchObject({ processed: 0, promoted: 0, conversations: 1 });
  const stats = collectStats(paths);
  expect(stats).toMatchObject({ conversations: 1, summaries: 0 });
});

it("replay reset retains and flags a node that references the reset session summary", async () => {
  const { cwd, paths, config } = fixture();
  let db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec(`INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'Session decision', 10);
    INSERT INTO summary_messages VALUES ('source', 1, 0);
    INSERT INTO replay_manifest(run_id, command, position, session_id) VALUES ('run', 'compact', 0, 'session');`);
  db.close();
  await invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 10 });
  db = new DatabaseSync(projectDbPath(cwd, paths));
  const node = db.prepare("SELECT summary_id FROM timeline_nodes").get() as { summary_id: string }; db.close();
  expect(await invokeRoute(createReplayResetHandler(paths), { cwd, command: "compact" })).toMatchObject({ cleared: true });
  db = new DatabaseSync(projectDbPath(cwd, paths));
  expect(db.prepare("SELECT stale_reason FROM timeline_nodes WHERE summary_id = ?").get(node.summary_id)).toMatchObject({ stale_reason: "session-changed" });
  expect(db.prepare("SELECT * FROM summaries WHERE summary_id = ?").get(node.summary_id)).toBeDefined();
  expect(db.prepare("SELECT * FROM summary_parents WHERE summary_id = ?").all(node.summary_id)).toEqual([]);
  db.close();
});

it.each(["unbounded", "session-pool"])("refuses %s before timeline work and leaves units and nodes untouched", async provider => {
  const { cwd, paths } = fixture();
  const mock = loadDaemonConfig(paths.configPath, { summarizer: { mock: true }, timeline: { generationEnabled: true } });
  await invokeRoute(createTimelineHandler(mock, paths), { cwd, calls: 10 });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec("UPDATE messages SET content = 'new source'");
  await invokeRoute(createTimelineHandler(mock, paths), { cwd, calls: 0 });
  const tables = ["timeline_state", "timeline_dirty", "timeline_items", "timeline_units", "timeline_nodes"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const config = loadDaemonConfig(paths.configPath, { llm: { provider, ...(provider === "unbounded" ? { providers: {
    unbounded: { type: "openai", apiKey: "fake", model: "fake" },
  } } : { fallbackProvider: "disabled" }) }, summarizer: { mock: false }, timeline: { generationEnabled: true } });
  const enqueue = vi.fn();
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  const factory = vi.spyOn(summarizers, "createSummarizer");
  try {
    const refusal = await invokeRoute(createTimelineHandler(config, paths, { enqueue } as never), { cwd, calls: 2 }).catch(error => error);
    expect(refusal.status).toBe(409);
    expect(refusal.message).toBe('HTTP 409: {"error":"Timeline provider chain requires bounded HTTP admission: configure every provider and fallback as a named openai or anthropic endpoint with maxConcurrent"}');
    expect(enqueue).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  } finally { db.close(); migrate.mockRestore(); factory.mockRestore(); }
});

it("unfinished bootstrap does not schedule automatic model work", async () => {
  const { cwd, paths } = fixture();
  const config = loadDaemonConfig(paths.configPath, { daemon: { port: 0, idleTimeoutMs: 0 }, llm: { provider: "disabled" }, summarizer: { mock: false }, timeline: { generationEnabled: true } });
  const factory = vi.spyOn(summarizers, "createSummarizer").mockResolvedValue(async () => "Scripted answer with retained session evidence.");
  vi.stubEnv("VITEST", "true");
  vi.useFakeTimers();
  const daemon = await createDaemon(config, { paths });
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(factory).not.toHaveBeenCalled();
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    expect(db.prepare("SELECT published FROM timeline_state").get()).toMatchObject({ published: 0 });
    db.close();
  } finally {
    await daemon.stop();
    vi.useRealTimers(); vi.unstubAllEnvs(); factory.mockRestore();
  }
});

it("the disabled timeline module does not migrate, plan or generate even on explicit requests", async () => {
  const { cwd, paths, config } = fixture();
  expect(loadDaemonConfig(paths.configPath).timeline.generationEnabled).toBe(false);
  config.timeline.generationEnabled = false;
  const handler = createTimelineHandler(config, paths);
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  const factory = vi.spyOn(summarizers, "createSummarizer");
  try {
    await expect(invokeRoute(handler, { cwd, calls: 10 })).rejects.toThrow("timeline.generationEnabled");
    expect(migrate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    expect(db.prepare("SELECT published FROM timeline_state").get()).toMatchObject({ published: 0 });
    db.close();
  } finally { migrate.mockRestore(); factory.mockRestore(); }
});

it("status preserves main's ordinary counts on a store without timeline migrations", async () => {
  const { cwd, paths, config } = fixture();
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec(`INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('source', 1, 'leaf', 'Source', 1);
    INSERT INTO promoted(id, content, project_id) VALUES ('memory', 'Claim', 'project');`);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").all() as Array<{ name: string }>) db.exec(`DROP TRIGGER ${row.name}`);
  db.exec("DROP INDEX timeline_owner_idx; DROP INDEX timeline_session_idx; ALTER TABLE conversations DROP COLUMN is_timeline; DROP TABLE timeline_memory_refs; DROP TABLE timeline_sources; DROP TABLE timeline_nodes; DROP TABLE timeline_items; DROP TABLE timeline_units; DROP TABLE timeline_dirty");
  db.close();
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  try {
    const status = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(status.project).toMatchObject({ messageCount: 1, summaryCount: 1, promotedCount: 1 });
    expect(status.project).not.toHaveProperty("timeline");
    expect(migrate).not.toHaveBeenCalled();
  } finally { migrate.mockRestore(); }
});

it("automatic timeline requests are rejected even when the module is enabled", async () => {
  const { cwd, paths, config } = fixture();
  await expect(invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 10, background: true })).rejects.toThrow("internal");
});

it("enable creates tracking for an empty project before its first capture", async () => {
  const { cwd, paths, config } = fixture();
  rmSync(projectDbPath(cwd, paths));
  config.timeline.generationEnabled = false;
  expect(await invokeRoute(createTimelineHandler(config, paths), { cwd, action: "enable", calls: 0 })).toMatchObject({ calls: 0 });
  const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
  try {
    expect(db.prepare("SELECT tracking, phase FROM timeline_state").get()).toMatchObject({ tracking: 1, phase: "ready" });
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'").get()).toMatchObject({ n: expect.any(Number) });
    expect(db.prepare("SELECT COUNT(*) n FROM conversations").get()).toMatchObject({ n: 0 });
  } finally { db.close(); }
});
