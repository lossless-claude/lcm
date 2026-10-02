import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import type { RouteHandler } from "../server.js";
import { sendJson } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import { backfillProjectCommits } from "../../session-commits.js";
import { projectDbPath, projectId } from "../project.js";
import { enqueue, withProjectMutation } from "../project-queue.js";
import { validateCwd } from "../validate-cwd.js";
import { sanitizeError } from "../safe-error.js";

export function createCommitBackfillHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    try {
      const cwd = validateCwd(JSON.parse(body || "{}").cwd);
      const dbPath = projectDbPath(cwd, paths);
      if (!config.commits.enabled || !existsSync(dbPath)) {
        sendJson(res, 200, { updated: 0, candidates: 0, references: 0 }); return;
      }
      const report = await enqueue(projectId(cwd), turn => withProjectMutation(projectId(cwd), async lease => {
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          return await backfillProjectCommits(db, cwd, true, { yieldWhile: work => lease.yieldWhile(() => turn.yieldWhile(work)) });
        } finally { closeLcmConnection(dbPath); }
      }));
      sendJson(res, 200, report);
    } catch (error) { sendJson(res, 500, { error: sanitizeError(error instanceof Error ? error.message : "commit repair failed") }); }
  };
}
