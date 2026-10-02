import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

it("adding the summary event-time flag to an upgraded store rewrites no summary", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runLcmMigrations(db, { fts5Available: false });
    db.exec(`INSERT INTO conversations(session_id) VALUES ('session');
      INSERT INTO messages(conversation_id, seq, role, content, token_count, created_at)
        VALUES (1, 0, 'user', 'first', 1, '2026-01-01 00:00:00'), (1, 1, 'assistant', 'second', 1, '2026-01-02 00:00:00');
      INSERT INTO summaries(summary_id, conversation_id, kind, content, token_count, earliest_at, latest_at)
        VALUES ('leaf', 1, 'leaf', 'summary', 1, 'kept-earliest', 'kept-latest');
      INSERT INTO summary_messages(summary_id, message_id, ordinal) VALUES ('leaf', 1, 0), ('leaf', 2, 1);`);
    // A store upgraded by the previous release: every other column present, this flag missing.
    db.exec("ALTER TABLE summaries DROP COLUMN has_event_time");
    const before = db.prepare("SELECT summary_id, depth, earliest_at, latest_at, descendant_count FROM summaries").all();

    const prepare = db.prepare.bind(db);
    const statements: string[] = [];
    db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql); }) as typeof db.prepare;
    const exec = db.exec.bind(db);
    db.exec = ((sql: string) => { statements.push(sql); return exec(sql); }) as typeof db.exec;
    try { runLcmMigrations(db, { fts5Available: false }); } finally { db.prepare = prepare; db.exec = exec; }

    expect(db.prepare("SELECT summary_id, depth, earliest_at, latest_at, descendant_count FROM summaries").all()).toEqual(before);
    expect(db.prepare("SELECT has_event_time FROM summaries").get()).toEqual({ has_event_time: 0 });
    expect(statements.filter(sql => /UPDATE\s+summaries/i.test(sql))).toEqual([]);
  } finally { db.close(); }
});
