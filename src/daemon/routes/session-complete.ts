import { DatabaseSync } from "node:sqlite";
import { projectDbPath } from "../project.js";
import { openProject } from "../project-group.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { markSessionComplete } from "../../capture.js";

export function createSessionCompleteHandler(paths: LcmPaths): RouteHandler {
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
    openProject(cwd, paths);
    const db = new DatabaseSync(projectDbPath(cwd, paths));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      markSessionComplete(db, session_id, message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } finally {
      db.close();
    }
  };
}
