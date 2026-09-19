import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectDbPath } from "../project.js";
import { readProjectMeta } from "../project-meta.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { PKG_VERSION } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { sanitizeError } from "../safe-error.js";
import { compactingSessionsFor } from "./compact.js";
import { PromotedStore } from "../../db/promoted.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";

export function createStatusHandler(config: DaemonConfig, paths: LcmPaths, startTime: number, actualPort?: number): RouteHandler {
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
        sendJson(res, 400, { error: sanitizeError(err instanceof Error ? err.message : "invalid cwd") });
        return;
      }

      // Calculate daemon uptime in seconds
      const uptime = Math.floor((Date.now() - startTime) / 1000);

      // Use actual port if provided, otherwise fall back to config port
      const port = actualPort ?? config.daemon.port;

      // Query project database for stats
      let messageCount = 0;
      let summaryCount = 0;
      let promotedCount = 0;

      const dbPath = projectDbPath(cwd, paths);
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("PRAGMA busy_timeout = 5000");

          messageCount = await new ConversationStore(db).getMessageCount();
          summaryCount = await new SummaryStore(db).countSummaries();
          promotedCount = new PromotedStore(db).count();
        } catch {
          // If database query fails, return zeros
          messageCount = 0;
          summaryCount = 0;
          promotedCount = 0;
        } finally {
          db.close();
        }
      }

      const meta = readProjectMeta(cwd, paths);
      const lastIngest = meta?.lastIngest ?? null;
      const lastCompact = meta?.lastCompact ?? null;
      const lastPromote = meta?.lastPromote ?? null;

      sendJson(res, 200, {
        daemon: {
          version: PKG_VERSION,
          uptime,
          port,
        },
        project: {
          messageCount,
          summaryCount,
          promotedCount,
          lastIngest,
          lastCompact,
          lastPromote,
          compactingSessions: compactingSessionsFor(cwd),
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: sanitizeError(err instanceof Error ? err.message : "status failed") });
    }
  };
}
