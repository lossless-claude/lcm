import type { DatabaseSync } from "node:sqlite";

/** Select valid, active usage signals with feedback's literal target-tag matching. */
function usageRows(source: string): string {
  const tags = `CASE WHEN json_valid(p.tags) THEN
    CASE WHEN json_type(p.tags) = 'array' THEN p.tags ELSE '[]' END ELSE '[]' END`;
  return `INSERT INTO recall_usage (signal_id, memory_id)
    SELECT p.id, substr(t.value, 11) FROM ${source} AS p, json_each(${tags}) AS t
    WHERE p.archived_at IS NULL AND p.tags LIKE '%"signal:memory_used"%'
      AND t.type = 'text' AND substr(t.value, 1, 10) = 'memory_id:' AND length(t.value) > 10
      AND instr(p.tags, '"memory_id:' || substr(t.value, 11) || '"') > 0
      AND NOT EXISTS (SELECT 1 FROM json_each(${tags}) WHERE type != 'text')
      AND (SELECT COUNT(*) FROM json_each(${tags}) WHERE substr(value, 1, 10) = 'memory_id:') = 1;`;
}

/** Backfill once; triggers keep usage lookup independent of the promoted row count. */
export function installRecallUsage(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recall_usage'").get()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recall_usage'").get()) {
      db.exec(`CREATE TABLE recall_usage (
        signal_id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL
      );
      CREATE INDEX recall_usage_memory_idx ON recall_usage (memory_id);
      CREATE TRIGGER recall_usage_insert AFTER INSERT ON promoted BEGIN
        ${usageRows("(SELECT NEW.id AS id, NEW.tags AS tags, NEW.archived_at AS archived_at)")}
      END;
      CREATE TRIGGER recall_usage_update AFTER UPDATE OF id, tags, archived_at ON promoted BEGIN
        DELETE FROM recall_usage WHERE signal_id = OLD.id;
        ${usageRows("(SELECT NEW.id AS id, NEW.tags AS tags, NEW.archived_at AS archived_at)")}
      END;
      CREATE TRIGGER recall_usage_delete AFTER DELETE ON promoted BEGIN
        DELETE FROM recall_usage WHERE signal_id = OLD.id;
      END;
      ${usageRows("promoted")}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
