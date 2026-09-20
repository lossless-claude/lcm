import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { projectDbPath } from "../project.js";
import type { LcmPaths } from "../../lcm-paths.js";

/**
 * The one place a restore opens a project database: every read of a restore runs inside
 * one of these scopes, on a migrated handle, so no section can leak a connection or
 * migrate the same file twice.
 */

/**
 * Opens the project's database — creating it when it is absent — migrates it, hands it to
 * `fn` and closes it before returning, on every path.
 *
 * The open is fatal when it fails: a restore that answers with a thin context because a
 * database could not be reached would silently report "no memory" for a project that has
 * some.
 */
export async function withProjectDb<T>(cwd: string, paths: LcmPaths, fn: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const dbPath = projectDbPath(cwd, paths);
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db);
    return await fn(db);
  } finally {
    closeLcmConnection(dbPath);
  }
}

/**
 * The same on a database that already exists: nothing is created, and an absent or
 * unopenable file means "this project has no state to read".
 *
 * A restore must never fail over its own hint — the compaction mark, a snapshot — so this
 * scope degrades where `withProjectDb` refuses.
 */
export async function withExistingProjectDb<T>(cwd: string, paths: LcmPaths, fn: (db: DatabaseSync) => T | Promise<T>): Promise<T | undefined> {
  if (!existsSync(projectDbPath(cwd, paths))) return undefined;
  try {
    return await withProjectDb(cwd, paths, fn);
  } catch {
    return undefined;
  }
}