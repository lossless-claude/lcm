import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
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
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body || "{}") as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd as string);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { stale: [], total: 0 });
      return;
    }

    let openedDbPath: string | null = null;
    try {
      const db = getLcmConnection(dbPath);
      openedDbPath = dbPath;
      runLcmMigrations(db);
      const store = new PromotedStore(db);

      // Handle archive/revive actions
      const action = input.action as string | undefined;
      const targetId = input.target_id as string | undefined;

      if (action && targetId) {
        if (action !== "archive" && action !== "revive") {
          sendJson(res, 400, { error: `Unknown action: ${action}. Use "archive" or "revive".` });
          return;
        }

        // Verify target exists before acting
        const exists = db.prepare("SELECT 1 FROM promoted WHERE id = ?").get(targetId);
        if (!exists) {
          sendJson(res, 404, { error: `Memory ${targetId} not found` });
          return;
        }

        if (action === "archive") {
          store.archive(targetId);
          sendJson(res, 200, { action: "archived", id: targetId });
        } else {
          store.revive(targetId);
          sendJson(res, 200, { action: "revived", id: targetId });
        }
        return;
      }

      const staleRows = store.findStale({
        staleAfterDays: config.restoration.staleAfterDays,
        staleSurfacingWithoutUseLimit: config.restoration.staleSurfacingWithoutUseLimit,
        projectId: input.project_id as string | undefined,
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

      sendJson(res, 200, { stale, total: stale.length });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "review-stale failed" });
    } finally {
      if (openedDbPath) closeLcmConnection(openedDbPath);
    }
  };
}
