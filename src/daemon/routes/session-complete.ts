import { DatabaseSync } from "node:sqlite";
import { projectDbPath, ensureProjectDir } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";

export function createSessionCompleteHandler(): RouteHandler {
  return async (_req, res, body) => {
    const { session_id, cwd, message_count } = JSON.parse(body || "{}");
    if (!session_id || !cwd) {
      sendJson(res, 400, { error: "session_id and cwd required" });
      return;
    }
    ensureProjectDir(cwd);
    const db = new DatabaseSync(projectDbPath(cwd));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      db.prepare(
        "INSERT OR REPLACE INTO session_ingest_log (session_id, message_count) VALUES (?, ?)",
      ).run(session_id, message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } finally {
      db.close();
    }
  };
}
