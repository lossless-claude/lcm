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
import { timelineProviderAdmitted, TIMELINE_ADMISSION_ERROR } from "../../src/daemon/project-timeline.js";
import { SummarizeJobStore } from "../../src/daemon/summarize-jobs.js";

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
it("status counts ready timeline units separately from months awaiting replan without writes", async () => {
  const { cwd, paths, config } = fixture();
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec(`INSERT INTO timeline_months(month, replan) VALUES ('2026-08', 1), ('2026-09', 0);
    INSERT INTO timeline_units(work_key, level, month, metadata, status, period_to) VALUES
      ('one', 'digest', '2026-08', '{}', 'ready', '2026-08-01'),
      ('two', 'digest', '2026-08', '{}', 'ready', '2026-08-02'),
      ('three', 'digest', '2026-08', '{}', 'ready', '2026-08-03'),
      ('parked', 'digest', '2026-09', '{}', 'parked', '2026-09-01');`);
  const tables = ['timeline_units', 'timeline_months', 'timeline_dirty', 'timeline_state'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  const factory = vi.spyOn(summarizers, "createSummarizer");
  try {
    const status = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(status.project).toMatchObject({ timeline: { calls: 0, pending: 3, replanMonths: 1, parked: 1, stale: 0 } });
    expect(migrate).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  } finally { migrate.mockRestore(); factory.mockRestore(); db.close(); }
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

it.each([false, true])("admits the session pool with only ordered fallbacks (named endpoints %s)", named => {
  const { paths } = fixture();
  const config = loadDaemonConfig(paths.configPath, { llm: {
    provider: "session-pool",
    ...(named ? { providers: { bounded: { type: "openai", model: "fake", apiKey: "fake", maxConcurrent: 1 } }, fallback: ["bounded"] }
      : { fallbackProvider: "disabled" }),
  } }, {});
  expect(timelineProviderAdmitted(config)).toBe(true);
});

it("generates timeline nodes through pool jobs bound to the reserved timeline session", async () => {
  const { cwd, paths } = fixture();
  const config = loadDaemonConfig(paths.configPath, { llm: { provider: "session-pool", fallbackProvider: "disabled" },
    summarizer: { mock: false }, timeline: { generationEnabled: true } }, {});
  const jobs = new SummarizeJobStore();
  const worker = (async () => {
    for (let count = 0; count < 2; count++) {
      const job = await jobs.nextWorker("timeline-worker");
      expect(job).toMatchObject({ pool: true, session_id: TIMELINE_SESSION_ID, workClass: "timeline" });
      jobs.answer(job!.id, { text: "The project chose SQLite.", providerId: "session-pool:haiku" });
    }
  })();
  try {
    await expect(Promise.all([
      invokeRoute<SettleReport>(createTimelineHandler(config, paths, jobs), { cwd, calls: 2 }),
      worker,
    ])).resolves.toMatchObject([{ generated: 2, calls: 2, stopped: "complete" }, undefined]);
  } finally { jobs.close(); }
});

it.each(["unbounded", "session-pool", "missing-env"])("refuses %s before timeline work and leaves units and nodes untouched", async provider => {
  const { cwd, paths } = fixture();
  const mock = loadDaemonConfig(paths.configPath, { summarizer: { mock: true }, timeline: { generationEnabled: true } });
  await invokeRoute(createTimelineHandler(mock, paths), { cwd, calls: 10 });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec("UPDATE messages SET content = 'new source'");
  await invokeRoute(createTimelineHandler(mock, paths), { cwd, calls: 0 });
  const tables = ["timeline_state", "timeline_dirty", "timeline_items", "timeline_units", "timeline_nodes"];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const config = loadDaemonConfig(paths.configPath, { llm: { provider, ...(provider !== "session-pool" ? { providers: {
    [provider]: { type: "openai", apiKey: provider === "missing-env" ? "\${TIMELINE_TEST_ABSENT_KEY}" : "fake", model: "fake", ...(provider === "missing-env" ? { maxConcurrent: 1 } : {}) },
  } } : { fallbackProvider: "auto" }) }, summarizer: { mock: false }, timeline: { generationEnabled: true } });
  const enqueue = vi.fn();
  const migrate = vi.spyOn(migrations, "runLcmMigrations");
  const factory = vi.spyOn(summarizers, "createSummarizer");
  try {
    const refusal = await invokeRoute(createTimelineHandler(config, paths, { enqueue } as never), { cwd, calls: 2 }).catch(error => error);
    expect(refusal.status).toBe(409);
    expect(refusal.message).toBe(`HTTP 409: ${JSON.stringify({ error: TIMELINE_ADMISSION_ERROR })}`);
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


it.each([1, 8])("fixing admission releases legacy configuration failures once (failures %s)", async failures => {
  const { cwd, paths, config: mock } = fixture();
  await invokeRoute(createTimelineHandler(mock, paths), { cwd, calls: 0 });
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.prepare("UPDATE timeline_units SET failures = ?, status = ?, next_try = '2999-01-01T00:00:00Z'")
    .run(failures, failures === 8 ? "parked" : "ready");
  const before = db.prepare("SELECT * FROM timeline_units").all();
  const configured = () => loadDaemonConfig(paths.configPath, {
    llm: { provider: "bounded", providers: { bounded: {
      type: "openai", apiKey: "$" + "{TIMELINE_TEST_RECOVERY_KEY}", model: "fake", maxConcurrent: 1,
    } } }, summarizer: { mock: false }, timeline: { generationEnabled: true },
  });
  const factory = vi.spyOn(summarizers, "createSummarizer").mockResolvedValue(async () => "Scripted timeline answer.");
  vi.stubEnv("TIMELINE_TEST_RECOVERY_KEY", undefined);
  try {
    const refused = await invokeRoute(createTimelineHandler(configured(), paths), { cwd, calls: 1 }).catch(error => error);
    expect(refused.status).toBe(409);
    expect(db.prepare("SELECT * FROM timeline_units").all()).toEqual(before);
    expect(factory).not.toHaveBeenCalled();
    vi.stubEnv("TIMELINE_TEST_RECOVERY_KEY", "fake");
    const config = configured();
    expect(await invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 1 })).toMatchObject({ generated: 1, calls: 1 });
    await invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 0 });
    db.exec("UPDATE timeline_units SET failures = 8, status = 'parked', next_try = '2999-01-01T00:00:00Z'");
    const later = db.prepare("SELECT * FROM timeline_units").all();
    expect(later.length).toBeGreaterThan(0);
    expect(await invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 2 })).toMatchObject({ generated: 0, calls: 0 });
    expect(db.prepare("SELECT * FROM timeline_units").all()).toEqual(later);
  } finally { db.close(); factory.mockRestore(); vi.unstubAllEnvs(); }
});


it.each([false, true])("teardown removes nodes only when requested (removeNodes %s)", async removeNodes => {
  const { cwd, paths, config } = fixture();
  const handler = createTimelineHandler(config, paths);
  await invokeRoute(handler, { cwd, calls: 10 });
  await invokeRoute(handler, { cwd, action: "teardown", calls: 0, removeNodes });
  const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
  try {
    const nodes = db.prepare("SELECT * FROM timeline_nodes").all();
    const summaries = db.prepare("SELECT s.summary_id FROM summaries s JOIN conversations c USING(conversation_id) WHERE c.is_timeline = 1").all();
    expect(nodes).toHaveLength(removeNodes ? 0 : 2);
    expect(summaries).toHaveLength(removeNodes ? 0 : 2);
    expect(db.prepare("SELECT content FROM messages").all()).toEqual([{ content: "We chose SQLite." }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});


it("status uses SQLite table counts plus indexed owner subtraction for ordinary counts", async () => {
  const { cwd, paths, config } = fixture();
  const db = new DatabaseSync(projectDbPath(cwd, paths));
  db.exec("INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count) VALUES ('one', 1, 'leaf', 'source', 1), ('two', 1, 'leaf', 'source', 1)");
  await invokeRoute(createTimelineHandler(config, paths), { cwd, calls: 10 });
  const statements: string[] = [];
  const original = DatabaseSync.prototype.prepare;
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    statements.push(sql);
    return original.call(this, sql);
  });
  try {
    const status = await invokeRoute<{ project: unknown }>(createStatusHandler(config, paths, Date.now()), { cwd });
    expect(status.project).toMatchObject({ messageCount: 1, summaryCount: 2 });
    prepare.mockRestore();
    for (const table of ["messages", "summaries"]) {
      const sql = statements.find(sql => sql.includes(`FROM ${table}`) && sql.includes("COUNT(*)"))!;
      const program = db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: string }>;
      expect(program.some(row => row.opcode === "Count")).toBe(true);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes("COVERING INDEX") && row.detail.includes("conversation_id=?"))).toBe(true);
    }
  } finally { prepare.mockRestore(); db.close(); }
});

it("status reads timeline unit and replan counts through covering indexes", async () => {
  const { cwd, paths, config } = fixture();
  const statements: string[] = [];
  const original = DatabaseSync.prototype.prepare;
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (sql) {
    statements.push(sql);
    return original.call(this, sql);
  });
  try {
    await invokeRoute(createStatusHandler(config, paths, Date.now()), { cwd });
  } finally { prepare.mockRestore(); }
  const db = new DatabaseSync(projectDbPath(cwd, paths), { readOnly: true });
  try {
    for (const table of ["timeline_units", "timeline_months"]) {
      const queries = statements.filter(sql => sql.includes(`FROM ${table}`) && sql.includes("COUNT(*)"));
      expect(queries).toHaveLength(table === "timeline_units" ? 2 : 1);
      for (const sql of queries) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
        expect(plan.some(row => row.detail.includes("COVERING INDEX"))).toBe(true);
      }
    }
  } finally { db.close(); }
});
