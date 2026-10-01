import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "./config.js";
import type { LcmPaths } from "../lcm-paths.js";
import { projectDbPath, projectId } from "./project.js";
import { hasQueuedProjectWork, hasBlockingProjectWork } from "./project-queue.js";
import { closeLcmConnection, getLcmConnection } from "../db/connection.js";
import { daemonTimeline, hasTimelineWork, timelineProviderAdmitted, timelineTick } from "./project-timeline.js";
import type { SummarizeJobStore } from "./summarize-jobs.js";

/** Ordinary ticks resume persisted plans when generation and admission are enabled. */
export async function sweepTimelines(config: DaemonConfig, paths: LcmPaths, jobs?: Pick<SummarizeJobStore, "enqueue">): Promise<void> {
  if (!config.timeline.generationEnabled || !timelineProviderAdmitted(config)) return;
  const entries = await readdir(paths.projectsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let dbPath: string | undefined;
    let opened = false;
    try {
      const meta = JSON.parse(await readFile(join(paths.projectsDir, entry.name, "meta.json"), "utf8")) as { cwd?: string };
      if (!meta.cwd || projectId(meta.cwd) !== entry.name) continue;
      const pid = projectId(meta.cwd);
      if (hasTimelineWork(pid) || hasQueuedProjectWork(pid) || hasBlockingProjectWork(pid)) continue;
      dbPath = projectDbPath(meta.cwd, paths);
      const check = new DatabaseSync(dbPath, { readOnly: true });
      let tracking: boolean;
      try { tracking = Boolean((check.prepare("SELECT tracking FROM timeline_state WHERE id = 1").get() as { tracking: number })?.tracking); }
      finally { check.close(); }
      if (!tracking) continue;
      const db = getLcmConnection(dbPath); opened = true;
      await timelineTick(db, daemonTimeline(db, meta.cwd, config, paths, jobs), true);
    } catch { /* A project's failure leaves replay and other project work intact. */ }
    finally { if (opened && dbPath) closeLcmConnection(dbPath); }
  }
}
