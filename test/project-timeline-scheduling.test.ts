import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { enableTimeline } from "../src/db/project-timeline.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { timelineTick, timelineProviderAdmitted } from "../src/daemon/project-timeline.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";
import { loadDaemonConfig } from "../src/daemon/config.js";
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
  expect(timelineProviderAdmitted(config)).toBe(false);
  const http = loadDaemonConfig("/dev/null", { llm: { provider: "bounded", providers: {
    bounded: { type: "openai", apiKey: "fake", model: "fake", maxConcurrent: 1 },
    unbounded: { type: "anthropic", apiKey: "fake", model: "fake" },
  } } });
  expect(timelineProviderAdmitted(http)).toBe(true);
  http.llm.fallback = ["unbounded"]; expect(timelineProviderAdmitted(http)).toBe(false);
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
