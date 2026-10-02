import { workerDisplayId } from "../../worker-warning.js";
import { workerEnrollments } from "../../worker-session.js";
import { WORKER_WARNING } from "../../store/worker-store.js";
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
import type { TimelineStatusReport } from "../../project-timeline.js";

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
      let messageCount: number | null = 0;
      let summaryCount: number | null = 0;
      let promotedCount: number | null = 0;
      let timeline: TimelineStatusReport | undefined;

      const dbPath = projectDbPath(cwd, paths);
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const count = async (query: () => number | Promise<number>): Promise<number | null> => {
          try { return await query(); } catch { return null; }
        };
        try {
          messageCount = await count(() => new ConversationStore(db).getMessageCount());
          summaryCount = await count(() => new SummaryStore(db).countSummaries());
          promotedCount = await count(() => new PromotedStore(db).count());
          try {
            const pending = db.prepare("SELECT COUNT(*) n FROM timeline_units WHERE status = 'ready'").get() as { n: number };
            const replanMonths = db.prepare("SELECT COUNT(*) n FROM timeline_months WHERE replan = 1").get() as { n: number };
            const dirty = db.prepare("SELECT COUNT(*) n FROM timeline_dirty WHERE dirty = 1").get() as { n: number };
            const stale = db.prepare("SELECT COUNT(*) n FROM timeline_nodes WHERE active = 1 AND stale_reason IS NOT NULL").get() as { n: number };
            timeline = { generated: 0, calls: 0, pending: pending.n, replanMonths: replanMonths.n, stale: stale.n, dirty: dirty.n, stopped: "complete", failed: [] };
          } catch { /* Older stores or unavailable timeline counts leave that field absent. */ }
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
          workers: workerEnrollments(cwd, paths).map(worker => ({
            session_id: workerDisplayId(worker.session_id), client: worker.client, state: worker.state, last_activity: worker.last_activity,
          })),
          workerWarning: WORKER_WARNING,
          messageCount,
          summaryCount,
          promotedCount,
          timeline,
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
