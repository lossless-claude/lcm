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
    if (!sessionId.startsWith("agent-")) return false;
    return store.list().some(worker => {
      const root = claudeTranscriptPath(cwd, worker.session_id);
      return root && discoverSubagentTranscripts(join(dirname(root), worker.session_id))
        .some(sub => sub.sessionId === sessionId);
    });
  } finally { closeLcmConnection(path, { readOnly: true }); }
}

export async function registerWorkerSession(paths: LcmPaths, input: {
  sessionId: string; cwd: string; client: "claude" | "codex"; owner: string;
}): Promise<{ warning: string; unprovenanced: number }> {
  return withProjectMutation(projectId(input.cwd), async () => {
    openProject(input.cwd, paths);
    const dbPath = projectDbPath(input.cwd, paths);
    const db = getLcmConnection(dbPath);
    const events = new EventsDb(eventsDbPath(input.cwd, paths));
    try {
      runLcmMigrations(db);
      // Sidecar exclusion lands first: a command hook either writes before this cleanup
      // or sees the permanent sidecar gate. A failed main cleanup cannot release a job.
      const root = input.client === "claude" ? claudeTranscriptPath(input.cwd, input.sessionId) : null;
      const children = root ? discoverSubagentTranscripts(join(dirname(root), input.sessionId)) : [];
      events.excludeSessions([input.sessionId, ...children.map(sub => sub.sessionId)]);
      const result = new WorkerStore(db).register(input);
      events.excludeSessions(result.sessions);
      for (const child of children) new WorkerStore(db).exclude(child.sessionId, input.cwd, input.client);
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
