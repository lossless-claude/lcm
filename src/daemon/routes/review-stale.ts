import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { validateCwd } from "../validate-cwd.js";

export type StaleCandidate = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  confidence: number;
  createdAt: string;
  daysSinceCreated: number;
  surfacingCount: number;
  usageCount: number;
};

export function createReviewStaleHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}");
      if (!input.cwd) {
        sendJson(res, 400, { error: "cwd is required" });
        return;
      }

      let cwd: string;
      try {
        cwd = validateCwd(input.cwd);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
        return;
      }

      const dbPath = projectDbPath(cwd);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { stale: [], total: 0 });
        return;
      }

      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        runLcmMigrations(db);
        const store = new PromotedStore(db);

        const staleRows = store.findStale({
          staleAfterDays: config.restoration.staleAfterDays,
          staleSurfacingWithoutUseLimit: config.restoration.staleSurfacingWithoutUseLimit,
          projectId: input.project_id,
        });

        const stale: StaleCandidate[] = staleRows.map((row) => ({
          id: row.id,
          content: row.content,
          tags: JSON.parse(row.tags) as string[],
          projectId: row.project_id,
          confidence: row.confidence,
          createdAt: row.created_at,
          daysSinceCreated: row.daysSinceCreated,
          surfacingCount: row.surfacingCount,
          usageCount: row.usageCount,
        }));

        // Handle archive/revive actions
        const action = input.action as string | undefined;
        const targetId = input.target_id as string | undefined;

        if (action && targetId) {
          if (action === "archive") {
            store.archive(targetId);
            sendJson(res, 200, { action: "archived", id: targetId });
            return;
          } else if (action === "revive") {
            store.revive(targetId);
            sendJson(res, 200, { action: "revived", id: targetId });
            return;
          } else {
            sendJson(res, 400, { error: `Unknown action: ${action}. Use "archive" or "revive".` });
            return;
          }
        }

        sendJson(res, 200, { stale, total: stale.length });
      } finally {
        db.close();
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "review-stale failed" });
    }
  };
}
