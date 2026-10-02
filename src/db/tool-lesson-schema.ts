import type { DatabaseSync } from "node:sqlite";

const INCREMENTAL_TABLES = `
    CREATE TABLE IF NOT EXISTS tool_lesson_changes (
      session_id TEXT NOT NULL, call_id TEXT NOT NULL, PRIMARY KEY(session_id, call_id)
    );
    CREATE TABLE IF NOT EXISTS tool_lesson_invalid_sessions (session_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS tool_lesson_contributions (
      call_row INTEGER NOT NULL, kind TEXT NOT NULL, lesson_key TEXT NOT NULL,
      session_id TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      call_order TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(call_row, kind)
    );
    CREATE INDEX IF NOT EXISTS tool_lesson_contributions_session_idx ON tool_lesson_contributions(session_id, call_row, kind);
    CREATE INDEX IF NOT EXISTS tool_lesson_contributions_first_idx ON tool_lesson_contributions(lesson_key, first_seen);
    CREATE INDEX IF NOT EXISTS tool_lesson_contributions_last_idx ON tool_lesson_contributions(lesson_key, last_seen);
    CREATE INDEX IF NOT EXISTS tool_lesson_contributions_order_idx ON tool_lesson_contributions(lesson_key, call_order);
    CREATE TABLE IF NOT EXISTS tool_lesson_successes (
      call_row INTEGER PRIMARY KEY, session_id TEXT NOT NULL, shape TEXT NOT NULL,
      call_order TEXT NOT NULL, seen TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tool_lesson_successes_shape_idx ON tool_lesson_successes(shape, call_order);
    CREATE INDEX IF NOT EXISTS tool_lesson_successes_session_idx ON tool_lesson_successes(session_id, call_row);
    CREATE TABLE IF NOT EXISTS tool_lesson_totals (
      lesson_key TEXT PRIMARY KEY, data TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS tool_lesson_totals_dirty_idx ON tool_lesson_totals(dirty, lesson_key);
    CREATE TABLE IF NOT EXISTS tool_lesson_progress (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), pair_count INTEGER NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO tool_lesson_progress (singleton, pair_count) VALUES (1, 0);
    CREATE INDEX IF NOT EXISTS tool_lessons_key_generation_idx ON tool_lessons(lesson_key, generation);
    CREATE INDEX IF NOT EXISTS tool_lessons_active_order_idx ON tool_lessons(retired, last_seen DESC, lesson_key);
`;

const SOURCE_TRIGGERS = `
    CREATE TRIGGER IF NOT EXISTS tool_lesson_call_insert AFTER INSERT ON transcript_tool_calls BEGIN
      INSERT INTO tool_lesson_changes VALUES (NEW.session_id, NEW.call_id) ON CONFLICT DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS tool_lesson_call_update AFTER UPDATE ON transcript_tool_calls
    WHEN OLD.input IS NOT NEW.input OR OLD.name IS NOT NEW.name OR OLD.outcome IS NOT NEW.outcome
      OR OLD.block_reason IS NOT NEW.block_reason OR OLD.truncated IS NOT NEW.truncated
      OR OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.call_id IS NOT NEW.call_id
    BEGIN
      INSERT INTO tool_lesson_changes VALUES (NEW.session_id, NEW.call_id) ON CONFLICT DO NOTHING;
      INSERT INTO tool_lesson_invalid_sessions
        SELECT OLD.session_id WHERE OLD.message_id IS NOT NEW.message_id
          OR OLD.session_id IS NOT NEW.session_id OR OLD.call_id IS NOT NEW.call_id ON CONFLICT DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS tool_lesson_call_delete AFTER DELETE ON transcript_tool_calls BEGIN
      INSERT INTO tool_lesson_invalid_sessions VALUES (OLD.session_id) ON CONFLICT DO NOTHING;
      DELETE FROM tool_lesson_changes WHERE session_id = OLD.session_id AND call_id = OLD.call_id;
    END;
    CREATE TRIGGER IF NOT EXISTS tool_lesson_message_time AFTER UPDATE OF event_at, created_at ON messages
    WHEN OLD.event_at IS NOT NEW.event_at OR OLD.created_at IS NOT NEW.created_at BEGIN
      INSERT INTO tool_lesson_changes
        SELECT session_id, call_id FROM transcript_tool_calls WHERE message_id = NEW.message_id ON CONFLICT DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS tool_lesson_worker_insert AFTER INSERT ON summarize_workers BEGIN
      INSERT INTO tool_lesson_invalid_sessions VALUES (NEW.session_id) ON CONFLICT DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS tool_lesson_worker_delete AFTER DELETE ON summarize_workers BEGIN
      INSERT INTO tool_lesson_invalid_sessions VALUES (OLD.session_id) ON CONFLICT DO NOTHING;
    END;
`;

/** Journal source mutations transactionally; current stores need no write lock. */
export function ensureToolLessonIncrementalSchema(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tool_lesson_changes'").get()) return;
  db.exec("SAVEPOINT tool_lesson_schema");
  try {
    db.exec(INCREMENTAL_TABLES);
    db.exec(SOURCE_TRIGGERS);
    // Re-derive once on upgrade, including shapes from the previous format.
    db.exec(`
      INSERT INTO tool_lesson_changes SELECT session_id, call_id FROM transcript_tool_calls;
      INSERT INTO tool_lesson_totals (lesson_key, data)
        SELECT lesson_key, json_set(data, '$.count', 0, '$.sessionCounts', json('{}'))
        FROM tool_lessons WHERE generation = (SELECT generation FROM tool_lesson_state WHERE singleton = 1);
    `);
    db.exec("RELEASE tool_lesson_schema");
  } catch (error) {
    db.exec("ROLLBACK TO tool_lesson_schema; RELEASE tool_lesson_schema");
    throw error;
  }
}
