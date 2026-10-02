import { openStandaloneLcmConnection } from "../../db/connection.js";
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
    const db = openStandaloneLcmConnection(projectDbPath(cwd, paths));
    try {
      runLcmMigrations(db);
      markSessionComplete(db, session_id, message_count ?? 0);
      sendJson(res, 200, { recorded: true });
    } finally {
      db.close();
    }
  };
}
