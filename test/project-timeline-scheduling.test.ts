import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { enableTimeline } from "../src/db/project-timeline.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { daemonTimeline, timelineTick, timelineProviderAdmitted } from "../src/daemon/project-timeline.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
import { SummarizeJobStore } from "../src/daemon/summarize-jobs.js";
import { createLcmPaths } from "../src/lcm-paths.js";
const handles: DatabaseSync[] = [];
afterEach(() => { handles.splice(0).forEach(db => db.close()); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  const db = new DatabaseSync(":memory:"); handles.push(db); runLcmMigrations(db); enableTimeline(db);
  db.exec("INSERT INTO conversations(session_id) VALUES ('session'); INSERT INTO messages(conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'source', 10)");
  const summarize = vi.fn(async () => "Scripted result");
  const timeline = openProjectTimeline(db, { summarize, lease: work => withProjectMutation("tick", work) });
  await timeline.settle({ calls: 0 });
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date().toISOString());
  return { db, timeline, summarize };
}
it("the default-off gate, finished bootstrap and 60 second debounce govern one unit per tick", async () => {
  const { db, timeline, summarize } = await fixture();
  await timelineTick(db, timeline, false); vi.setSystemTime(Date.now() + 60000);
  await timelineTick(db, timeline, false); expect(summarize).not.toHaveBeenCalled();
  db.exec("UPDATE timeline_state SET phase = 'bootstrapping'");
  await timelineTick(db, timeline, true); expect(summarize).not.toHaveBeenCalled();
  db.exec("UPDATE timeline_state SET phase = 'ready'");
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date().toISOString());
  vi.setSystemTime(Date.now() + 59999); await timelineTick(db, timeline, true); expect(summarize).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 1); await timelineTick(db, timeline, true); expect(summarize).toHaveBeenCalledTimes(1);
  await timelineTick(db, timeline, true); expect(summarize).toHaveBeenCalledTimes(2);
});
it("replay holds expire without ledger progress and older unfinished runs do not hold a finished latest run", async () => {
  const { db, timeline, summarize } = await fixture();
  db.exec("INSERT INTO replay_manifest(run_id, command, position, session_id, created_at) VALUES ('old', 'compact', 0, 'session', '2026-08-01T11:59:00Z')");
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date().toISOString());
  vi.setSystemTime(Date.now() + 60000);
  await timelineTick(db, timeline, true); expect(summarize).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + 300000);
  await timelineTick(db, timeline, true); expect(summarize).toHaveBeenCalledTimes(1);
  db.exec(`INSERT INTO replay_manifest(run_id, command, position, session_id, created_at) VALUES ('latest', 'compact', 0, 'session', '2026-08-01T12:06:00Z');
    INSERT INTO replay_ledger(run_id, session_id, position, content_fingerprint, completed_at) VALUES ('latest', 'session', 0, 'done', '2026-08-01T12:06:00Z')`);
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date(Date.now() - 60000).toISOString());
  await timelineTick(db, timeline, true); expect(summarize).toHaveBeenCalledTimes(2);
});
it("timeline providers require admission on every fallback", () => {
  const config = loadDaemonConfig("/dev/null", { llm: { provider: "session-pool", fallbackProvider: "disabled" } });
  expect(timelineProviderAdmitted(config)).toBe(true);
  config.llm.fallbackProvider = "auto"; expect(timelineProviderAdmitted(config)).toBe(false);
  const http = loadDaemonConfig("/dev/null", { llm: { provider: "bounded", providers: {
    bounded: { type: "openai", apiKey: "fake", model: "fake", maxConcurrent: 1 },
    unbounded: { type: "anthropic", apiKey: "fake", model: "fake" },
  } } });
  expect(timelineProviderAdmitted(http)).toBe(true);
  http.llm.fallback = ["unbounded"]; expect(timelineProviderAdmitted(http)).toBe(false);
  http.llm.provider = "session-pool"; expect(timelineProviderAdmitted(http)).toBe(false);
  http.llm.fallback = ["bounded"]; expect(timelineProviderAdmitted(http)).toBe(true);
});

it("ticks alone resume migrated bootstrap one bounded page at a time before model work", async () => {
  const { db, timeline, summarize } = await fixture();
  const insert = db.prepare("INSERT INTO conversations(session_id) VALUES (?)");
  for (let index = 0; index < 600; index++) insert.run(`session-${String(index).padStart(3, "0")}`);
  db.exec("UPDATE timeline_state SET phase = 'ready'; ALTER TABLE timeline_sources DROP COLUMN time_basis");
  runLcmMigrations(db);
  expect(db.prepare("SELECT phase, bootstrap_cursor FROM timeline_state").get()).toMatchObject({ phase: "bootstrapping", bootstrap_cursor: "" });
  const cursors: string[] = [];
  const prepare = db.prepare.bind(db);
  const pages: number[] = [];
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (sql.includes("SELECT DISTINCT session_id FROM conversations")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => { const rows = all(...args); pages.push(rows.length); return rows; });
    }
    return statement;
  });
  let yielded = false; setImmediate(() => { yielded = true; });
  for (let tick = 0; tick < 3; tick++) {
    await timelineTick(db, timeline, true);
    cursors.push((prepare("SELECT bootstrap_cursor FROM timeline_state").get() as { bootstrap_cursor: string }).bootstrap_cursor);
    expect(pages).toHaveLength(tick + 1);
    expect(summarize).not.toHaveBeenCalled();
  }
  expect(pages).toEqual([256, 256, 89]);
  expect(new Set(cursors).size).toBe(3);
  expect(yielded).toBe(true);
  expect(prepare("SELECT phase FROM timeline_state").get()).toMatchObject({ phase: "ready" });
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date().toISOString());
  vi.setSystemTime(Date.now() + 60000);
  await timelineTick(db, timeline, true);
  expect(summarize).toHaveBeenCalledTimes(1);
});

it("migrated bootstrap refreshes clean session metadata without resetting write counters", async () => {
  const { db, timeline, summarize } = await fixture();
  db.exec(`UPDATE timeline_items SET metadata = json_remove(metadata, '$.coverage[0].timeBasis');
    UPDATE timeline_sessions SET fingerprint = 'pre-event-time';
    ALTER TABLE timeline_sources DROP COLUMN time_basis`);
  const before = db.prepare("SELECT rev FROM timeline_dirty WHERE session_id = 'session'").get();
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 0 });
  runLcmMigrations(db);
  await timelineTick(db, timeline, true);
  expect(db.prepare("SELECT dirty FROM timeline_dirty WHERE session_id = 'session'").get()).toMatchObject({ dirty: 1 });
  expect(db.prepare("SELECT rev FROM timeline_dirty WHERE session_id = 'session'").get()).toEqual(before);
  vi.setSystemTime(Date.now() + 60000);
  await timelineTick(db, timeline, true);
  const row = db.prepare("SELECT json_extract(metadata, '$.coverage[0].timeBasis') basis FROM timeline_items").get();
  expect(row).toEqual({ basis: "capture" });
  expect(summarize).toHaveBeenCalledTimes(1);
});

it("unclaimed timeline ticks stay ready behind background work and generate after it drains", async () => {
  const { db, timeline: scripted } = await fixture();
  await scripted.settle({ calls: 10 });
  db.exec("UPDATE messages SET content = 'Changed source'");
  await scripted.settle({ calls: 0 });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.now() + 60_000);
  const config = loadDaemonConfig("/dev/null", { llm: { provider: "session-pool", fallbackProvider: "disabled" } }, {});
  const jobs = new SummarizeJobStore();
  const timeline = daemonTimeline(db, "/timeline-pool-test", config, createLcmPaths(process.env.LCM_HOME!), jobs);
  // Complete the one-time admission recovery before comparing persisted retry state.
  await timeline.settle({ calls: 1, deadline: new Date() });
  db.prepare("UPDATE timeline_dirty SET bumped_at = ?").run(new Date(Date.now() - 60_000).toISOString());
  const units = () => db.prepare("SELECT work_key, failures, next_try, status FROM timeline_units ORDER BY work_key").all();
  const flags = () => db.prepare("SELECT summary_id, stale_reason, stale_since FROM timeline_nodes ORDER BY summary_id").all();
  const beforeUnits = units(), beforeFlags = flags();
  const settle = vi.spyOn(timeline, "settle");
  try {
    for (let tick = 0; tick < 9; tick++) {
      const background = jobs.enqueue({ session_id: "replay", pool: true, workClass: "background",
        kind: "leaf", depth: 0, system: "system", prompt: "background", targetTokens: 100, maxTokens: 200 });
      const pending = timelineTick(db, timeline, true);
      await vi.advanceTimersByTimeAsync(19_000);
      const job = await jobs.nextWorker("worker", undefined, false);
      expect(job?.workClass).toBe("background");
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(await settle.mock.results.at(-1)!.value).toMatchObject({ stopped: "busy", generated: 0, failed: [] });
      expect(units()).toEqual(beforeUnits);
      expect(units()).toEqual(expect.arrayContaining([expect.objectContaining({ failures: 0, status: "ready" })]));
      expect(flags()).toEqual(beforeFlags);
      expect(flags()).not.toEqual(expect.arrayContaining([expect.objectContaining({ stale_reason: "generate-failed" })]));
      jobs.answer(job!.id, { text: "Background summary" });
      await background;
    }
    const pending = timelineTick(db, timeline, true);
    await vi.advanceTimersByTimeAsync(0);
    const job = await jobs.nextWorker("worker", undefined, false);
    expect(job?.workClass).toBe("timeline");
    jobs.answer(job!.id, { text: "Timeline summary" });
    await pending;
    expect(await settle.mock.results.at(-1)!.value).toMatchObject({ generated: 1, failed: [] });
  } finally { jobs.close(); }
});
