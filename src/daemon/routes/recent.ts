import { existsSync } from "node:fs";
import { openStandaloneLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { SummaryStore } from "../../store/summary-store.js";
import { validateCwd } from "../validate-cwd.js";

export function createRecentHandler(_config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { limit = 5 } = input;

    if (!input.cwd) {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd, paths);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { summaries: [] });
        return;
      }
      const db = openStandaloneLcmConnection(dbPath);
      let summaries;
      try {
        runLcmMigrations(db);
        summaries = await new SummaryStore(db).listRecent(limit);
      } finally {
        db.close();
      }
      sendJson(res, 200, { summaries });
    } catch {
      sendJson(res, 200, { summaries: [] });
    }
  };
}
