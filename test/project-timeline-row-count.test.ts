import { DatabaseSync } from "node:sqlite";
import { beforeAll, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { enableTimeline } from "../src/db/project-timeline.js";
import { openProjectTimeline } from "../src/project-timeline.js";
import { withProjectMutation } from "../src/daemon/project-queue.js";

async function measuredSettle(messages: number, calls: number) {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db);
  enableTimeline(db);
  db.exec(`INSERT INTO conversations(conversation_id, session_id) VALUES (1, 'source-session');
    WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ${messages})
    INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at)
      SELECT 1, n, 'user', 'source', 1, '2026-08-01T12:00:00Z' FROM seq;
    INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count, earliest_at, latest_at)
      VALUES ('source', 1, 'leaf', 'One indivisible session summary', 10, '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z');
    INSERT INTO summary_messages(summary_id, message_id, ordinal)
      SELECT 'source', message_id, seq FROM messages;`);
  for (let i = 1; i < 50; i++) {
    db.prepare("INSERT INTO conversations(conversation_id, session_id) VALUES (?, ?)").run(i + 1, `dirty-${i}`);
    db.prepare(`INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count, earliest_at, latest_at)
      VALUES (?, ?, 'leaf', 'Small summary', 10, '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z')`).run(`small-${i}`, i + 1);
  }
  const deps = { lease: <T>(work: Parameters<typeof withProjectMutation<T>>[1]) => withProjectMutation(`row-count-${messages}`, work),
    summarize: async () => "Scripted replacement period" };
  await openProjectTimeline(db, deps).settle({ calls: 10 });
  db.exec("UPDATE summaries SET content = content || ' changed' WHERE conversation_id IN (SELECT conversation_id FROM conversations WHERE is_timeline = 0)");
  const original = db.prepare.bind(db);
  let rows = 0;
  let published = false;
  let sourceRowsAfterPublish = 0;
  const prepare = vi.spyOn(db, "prepare").mockImplementation(sql => {
    const statement = original(sql);
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    const run = statement.run.bind(statement);
    statement.all = (...args) => {
      const result = all(...args);
      rows += result.length;
      if (published && /FROM (messages|summary_messages|timeline_input_cache_batches)\b/.test(sql)) sourceRowsAfterPublish += result.length;
      return result;
    };
    statement.get = (...args) => { const result = get(...args); rows += result ? 1 : 0; return result; };
    statement.run = (...args) => {
      const result = run(...args);
      if (sql.startsWith("INSERT INTO timeline_nodes")) published = true;
      return result;
    };
    return statement;
  });
  try {
    const timeline = openProjectTimeline(db, {
      lease: work => withProjectMutation(`row-count-${messages}`, work),
      summarize: async () => "Scripted replacement period",
    });
    const report = await timeline.settle({ calls });
    return { rows, sourceRowsAfterPublish, generated: report.generated };
  } finally { prepare.mockRestore(); db.close(); }
}

type Measurement = Awaited<ReturnType<typeof measuredSettle>>;
const measurements = new Map<number, { small: Measurement; large: Measurement }>();

// Setup failures must fail the suite, rather than count as expected contract failures.
beforeAll(async () => {
  for (const calls of [0, 1]) {
    const small = await measuredSettle(10_000, calls);
    const large = await measuredSettle(100_000, calls);
    measurements.set(calls, { small, large });
    process.stdout.write(JSON.stringify({ calls, small, large }) + "\n");
  }
}, 60_000);

it("the row-count fixture builds only one unit and performs no source read after publication", () => {
  for (const calls of [0, 1]) {
    const { small, large } = measurements.get(calls)!;
    expect([small.generated, large.generated]).toEqual([calls, calls]);
    expect([small.sourceRowsAfterPublish, large.sourceRowsAfterPublish]).toEqual([0, 0]);
  }
});

it.each([0, 1])("initialized incremental acceptance: calls=%i reads only changed units regardless of store size", calls => {
  const { small, large } = measurements.get(calls)!;
  expect(Math.abs(large.rows - small.rows)).toBeLessThanOrEqual(20);

});
