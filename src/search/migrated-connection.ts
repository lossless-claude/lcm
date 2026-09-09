import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection } from "../db/connection.js";
import { runLcmMigrations } from "../db/migration.js";

/**
 * Databases this process has already brought up to date.
 *
 * The migration sweep is idempotent DDL with no version marker, so it costs
 * ~80 ms per database however little there is to do. Measured on the lcm group:
 * unioning five checkouts spends 4 ms searching and 394 ms migrating, against a
 * 500 ms budget for the whole prompt hook. Schema is per-file and the daemon
 * holds the only writer, so once per path per process is enough.
 *
 * The assumption is that a database file is not deleted and recreated at the
 * same path within one process. Project paths are derived from cwd, so that
 * only happens when a project is wiped and rebuilt while the daemon runs.
 */
const migrated = new Set<string>();

/** Opens a pooled connection, migrating that database the first time only. */
export function openMigrated(dbPath: string): DatabaseSync {
  const db = getLcmConnection(dbPath);
  if (!migrated.has(dbPath)) {
    runLcmMigrations(db);
    migrated.add(dbPath);
  }
  return db;
}

/** Forgets what has been migrated. For tests that rebuild a store in place. */
export function resetMigrationMemo(): void {
  migrated.clear();
}
