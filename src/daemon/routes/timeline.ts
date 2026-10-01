import { existsSync } from "node:fs";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import type { RouteHandler } from "../server.js";
import { sendJson } from "../server.js";
import { closeLcmConnection, getLcmConnection } from "../../db/connection.js";
import { enableTimeline, disableTimeline, teardownTimeline } from "../../db/project-timeline.js";
import { runLcmMigrations } from "../../db/migration.js";
import { projectDbPath, projectId, ensureProjectDir } from "../project.js";
import { updateProjectMeta } from "../project-meta.js";
import { enqueue, withProjectMutation } from "../project-queue.js";
import { validateCwd } from "../validate-cwd.js";
import { daemonTimeline, timelineProviderAdmitted, TIMELINE_ADMISSION_ERROR } from "../project-timeline.js";
import type { SummarizeJobStore } from "../summarize-jobs.js";
import { sanitizeError } from "../safe-error.js";

export function createTimelineHandler(config: DaemonConfig, paths: LcmPaths, jobs?: Pick<SummarizeJobStore, "enqueue">): RouteHandler {
  return async (_req, res, body) => {
    let dbPath: string | undefined;
    let opened = false;
    try {
      const input = JSON.parse(body || "{}");
      if (input.background === true) { sendJson(res, 400, { error: "Timeline scheduling is internal" }); return; }
      const action = input.action ?? "settle";
      if (!["enable", "disable", "teardown", "settle"].includes(action)) {
        sendJson(res, 400, { error: "Unknown timeline action" }); return;
      }
      if (action === "settle" && (input.calls ?? 10) > 0 && !config.timeline.generationEnabled) {
        sendJson(res, 409, { error: "Enable timeline.generationEnabled to generate project timeline nodes" }); return;
      }
      if (!input.cwd || !Number.isInteger(input.calls ?? 10) || (input.calls ?? 10) < 0 ||
        (input.reconcile !== undefined && !["journal", "full"].includes(input.reconcile))) {
        sendJson(res, 400, { error: "cwd, non-negative integer calls and journal/full reconciliation are required" }); return;
      }
      if (action === "settle" && (input.calls ?? 10) > 0 && !timelineProviderAdmitted(config)) {
        sendJson(res, 409, { error: TIMELINE_ADMISSION_ERROR }); return;
      }
      const cwd = validateCwd(input.cwd);
      dbPath = projectDbPath(cwd, paths);
      if (!existsSync(dbPath) && action === "enable") {
        ensureProjectDir(cwd, paths);
        updateProjectMeta(cwd, paths, { cwd });
      }
      if (!existsSync(dbPath) && action !== "enable") {
        sendJson(res, 200, { generated: 0, stale: 0, pending: 0, calls: 0, stopped: "complete", failed: [] }); return;
      }
      const db = getLcmConnection(dbPath);
      opened = true;
      await enqueue(projectId(cwd), () => withProjectMutation(projectId(cwd), async () => runLcmMigrations(db)));
      if (action !== "settle") await enqueue(projectId(cwd), () => withProjectMutation(projectId(cwd), async () => {
        if (action === "enable") enableTimeline(db);
        else if (action === "disable") disableTimeline(db);
        else teardownTimeline(db, input.removeNodes === true);
      }));
      const report = await daemonTimeline(db, cwd, config, paths, jobs).settle({ calls: action === "settle" ? input.calls ?? 10 : 0, reconcile: input.reconcile });
      sendJson(res, 200, report);
    } catch (error) { sendJson(res, 500, { error: sanitizeError(error instanceof Error ? error.message : "timeline settle failed") }); }
    finally { if (dbPath && opened) closeLcmConnection(dbPath); }
  };
}
