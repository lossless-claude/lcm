import type { LcmPaths } from "../lcm-paths.js";
import { workerEnrollments } from "../worker-session.js";
import { validateCwd } from "./validate-cwd.js";
import { projectDbPath, projectId } from "./project.js";
import { getLcmConnection, closeLcmConnection } from "../db/connection.js";
import { WorkerStore } from "../store/worker-store.js";
import { withProjectMutation } from "./project-queue.js";
import { EventsDb } from "../hooks/events-db.js";
import { eventsDbPath } from "../db/events-path.js";

export function workerBinding(cwd: string, client: string, sessionId: string): string {
  return JSON.stringify([projectId(cwd), client, sessionId]);
}

type Admission = { binding: string; sessionId: string; cwd: string; client: string };
export async function admitWorker(paths: LcmPaths | undefined, input: Record<string, unknown>, onAdmitted?: (admission: Admission) => void): Promise<Admission> {
  const { caller_session_id: sessionId, client, transport } = input;
  const verified = client === "claude" && ["cli", "mcp", "hook"].includes(String(transport)) ||
    client === "codex" && transport === "cli" || client === "omp" && transport === "hook";
  if (!paths || !verified || typeof sessionId !== "string" || !sessionId.trim() || typeof input.cwd !== "string") {
    throw new Error("Worker identity or harness/transport is unverified. Use a dedicated Claude Code worker, or Codex CLI, with lcm hooks enabled.");
  }
  const cwd = validateCwd(input.cwd);
  return withProjectMutation(projectId(cwd), async () => {
    const enrollments = workerEnrollments(cwd, paths);
    let enrolled = enrollments.find(worker => worker.session_id === sessionId && worker.client === client && worker.state === "active" && worker.owner);
    if (!enrolled && client === "claude" && sessionId.startsWith("agent-")) {
      // A child must be discovered under a live declared root, not just carry a marker.
      for (const root of enrollments.filter(worker => worker.state === "active" && worker.owner && worker.client === "claude")) {
        const { claudeTranscriptPath } = await import("./project.js");
        const { discoverSubagentTranscripts } = await import("../subagent-attribution.js");
        const { dirname, join } = await import("node:path");
        const path = claudeTranscriptPath(cwd, root.session_id);
        if (!path || !discoverSubagentTranscripts(join(dirname(path), root.session_id)).some(sub => sub.sessionId === sessionId)) continue;
        const dbPath = projectDbPath(cwd, paths); const db = getLcmConnection(dbPath);
        const events = new EventsDb(eventsDbPath(cwd, paths));
        try {
          events.excludeSessions([sessionId], true);
          const store = new WorkerStore(db);
          store.exclude(sessionId, cwd, "claude", true); store.admitChild(sessionId, cwd, root.owner!);
          enrolled = store.list().find(worker => worker.session_id === sessionId);
        } finally { events.close(); closeLcmConnection(dbPath); }
        break;
      }
    }
    if (!enrolled || enrolled.cwd !== cwd || enrolled.client !== client) {
      throw new Error("Use a dedicated live session started with LCM_SUMMARIZE_WORKER=1 and lcm hooks enabled. This session is undeclared, stale, finished, or a child without verified discovery.");
    }
    const dbPath = projectDbPath(cwd, paths); const db = getLcmConnection(dbPath);
    try {
      const store = new WorkerStore(db);
      if (!store.live(sessionId, cwd, String(client))) throw new Error("Use a dedicated live worker session; this admission was revoked");
      store.touch(sessionId);
      onAdmitted?.({ cwd, sessionId, client: String(client), binding: workerBinding(cwd, String(client), sessionId) });
    }
    finally { closeLcmConnection(dbPath); }
    return { cwd, sessionId, client, binding: workerBinding(cwd, client, sessionId) };
  });
}

/** Expiry revokes admission, never the permanent capture gate. */
export async function abandonWorker(paths: LcmPaths, binding: string): Promise<void> {
  const [pid, , sessionId] = JSON.parse(binding) as [string, string, string];
  const { join } = await import("node:path");
  const dbPath = join(paths.projectsDir, pid, "db.sqlite");
  await withProjectMutation(pid, async () => {
    const db = getLcmConnection(dbPath);
    try { new WorkerStore(db).finish(sessionId, "abandoned"); }
    finally { closeLcmConnection(dbPath); }
  });
}
