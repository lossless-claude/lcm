import { validateCwd } from "./daemon/validate-cwd.js";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { LcmPaths } from "./lcm-paths.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { projectDbPath, projectId, claudeTranscriptPath } from "./daemon/project.js";
import { openProject } from "./daemon/project-group.js";
import { withProjectMutation } from "./daemon/project-queue.js";
import { WorkerStore, WORKER_WARNING, type WorkerEnrollment } from "./store/worker-store.js";
import { EventsDb } from "./hooks/events-db.js";
import { eventsDbPath } from "./db/events-path.js";
import { discoverSubagentTranscripts } from "./subagent-attribution.js";

export function workerEnrollments(cwd: string, paths: LcmPaths): WorkerEnrollment[] {
  const path = projectDbPath(cwd, paths);
  if (!existsSync(path)) return [];
  const db = getLcmConnection(path, { readOnly: true });
  try { return new WorkerStore(db).list(); }
  finally { closeLcmConnection(path, { readOnly: true }); }
}

/** Only the native transcript walker can establish a descendant whose history may be removed. */
export function discoveredWorkerDescendant(store: WorkerStore, sessionId: string): boolean {
  return store.list().some(worker => {
    if (!worker.owner || worker.client !== "claude") return false;
    const root = claudeTranscriptPath(worker.cwd, worker.session_id);
    return Boolean(root && discoverSubagentTranscripts(join(dirname(root), worker.session_id))
      .some(sub => sub.sessionId === sessionId));
  });
}

export function workerExcluded(cwd: string, sessionId: string, paths: LcmPaths, transcriptPath?: string): boolean {
  const path = projectDbPath(cwd, paths);
  if (!existsSync(path)) return false;
  const db = getLcmConnection(path, { readOnly: true });
  try {
    const store = new WorkerStore(db);
    if (store.excluded(sessionId)) return true;
    const segments = transcriptPath?.split(sep) ?? [];
    const at = segments.indexOf("subagents");
    if (at > 0 && store.excluded(segments[at - 1])) return true;
    return discoveredWorkerDescendant(store, sessionId);
  } finally { closeLcmConnection(path, { readOnly: true }); }
}

export async function registerWorkerSession(paths: LcmPaths, input: {
  sessionId: string; cwd: string; client: "claude" | "codex" | "omp"; owner: string; source?: "startup" | "clear";
}): Promise<{ warning: string; unprovenanced: number }> {
  input = { ...input, cwd: validateCwd(input.cwd) };
  return withProjectMutation(projectId(input.cwd), async () => {
    openProject(input.cwd, paths);
    const dbPath = projectDbPath(input.cwd, paths);
    const db = getLcmConnection(dbPath);
    const events = new EventsDb(eventsDbPath(input.cwd, paths));
    try {
      runLcmMigrations(db);
      // SQLite protects the history check across processes. Sidecar enrollment only
      // installs a gate and refuses existing events; it cannot purge ordinary history.
      const store = new WorkerStore(db);
      if (input.source === "clear") store.finishOwner(input.owner);
      const result = store.register(input, () => events.enrollSessions([input.sessionId]));
      return { warning: WORKER_WARNING, unprovenanced: result.unprovenanced };
    } finally { events.close(); closeLcmConnection(dbPath); }
  });
}

export async function finishWorkerSession(paths: LcmPaths, cwd: string, sessionId: string): Promise<void> {
  await withProjectMutation(projectId(cwd), async () => {
    const path = projectDbPath(cwd, paths);
    if (!existsSync(path)) return;
    const db = getLcmConnection(path);
    try { new WorkerStore(db).finish(sessionId); }
    finally { closeLcmConnection(path); }
  });
}

export function excludedWorkerContext(paths: LcmPaths, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): boolean {
  if (env.LCM_SUMMARIZE_WORKER === "1") return true;
  const id = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  return Boolean(id && workerExcluded(cwd, id, paths));
}
