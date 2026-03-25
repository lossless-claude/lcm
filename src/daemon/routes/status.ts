import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath, projectMetaPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { PKG_VERSION } from "../server.js";
import { validateCwd } from "../validate-cwd.js";

export function createStatusHandler(config: DaemonConfig, startTime: number, actualPort?: number): RouteHandler {
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

      // Calculate daemon uptime in seconds
      const uptime = Math.floor((Date.now() - startTime) / 1000);

      // Use actual port if provided, otherwise fall back to config port
      const port = actualPort ?? config.daemon.port;

      // Query project database for stats
      let messageCount = 0;
      let summaryCount = 0;
      let promotedCount = 0;

      const dbPath = projectDbPath(cwd);
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("PRAGMA busy_timeout = 5000");

          // Count messages
          const msgResult = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
          messageCount = msgResult?.count ?? 0;

          // Count summaries
          const sumResult = db.prepare("SELECT COUNT(*) as count FROM summaries").get() as { count: number };
          summaryCount = sumResult?.count ?? 0;

          // Count promoted
          const promResult = db.prepare("SELECT COUNT(*) as count FROM promoted").get() as { count: number };
          promotedCount = promResult?.count ?? 0;
        } catch {
          // If database query fails, return zeros
          messageCount = 0;
          summaryCount = 0;
          promotedCount = 0;
        } finally {
          db.close();
        }
      }

      // Read meta.json for timestamps
      let lastIngest: string | null = null;
      let lastCompact: string | null = null;
      let lastPromote: string | null = null;

      const metaPath = projectMetaPath(cwd);
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          lastIngest = meta.lastIngest ?? null;
          lastCompact = meta.lastCompact ?? null;
          lastPromote = meta.lastPromote ?? null;
        } catch {
          // If meta.json parse fails, keep timestamps as null
        }
      }

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
        },
      });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "status failed" });
    }
  };
}
