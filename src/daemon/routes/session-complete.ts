import { DatabaseSync } from "node:sqlite";
import { projectDbPath, ensureProjectDir } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { validateCwd } from "../validate-cwd.js";

export function createSessionCompleteHandler(): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id, message_count } = input;
    if (!session_id || !input.cwd) {
      sendJson(res, 400, { error: "session_id and cwd required" });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }
    ensureProjectDir(cwd);
    const db = new DatabaseSync(projectDbPath(cwd));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      db.prepare(
        "INSERT INTO session_ingest_log (session_id, message_count) VALUES (?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET message_count = excluded.message_count",
      ).run(session_id, message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } finally {
      db.close();
    }
  };
}
