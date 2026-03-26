import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";

/** Returns true if lock was acquired, false if another live process holds it. */
function tryAcquireSessionLock(sessionId: string): boolean {
  const lockPath = join(tmpdir(), `lcm-restore-${sessionId}.lock`);
  try {
    writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — check if the owner process is still alive
    try {
      const ownerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(ownerPid)) {
        try {
          process.kill(ownerPid, 0); // throws ESRCH if dead, EPERM if alive but no permission
          return false; // owner alive, genuine dedup
        } catch (err: unknown) {
          const code = typeof err === "object" && err && "code" in err ? (err as { code?: unknown }).code : undefined;
          if (code !== "ESRCH") return false; // EPERM or unknown — assume alive
          // ESRCH: owner dead — atomically take over by unlinking then re-locking
          try { unlinkSync(lockPath); } catch { /* another process beat us to the unlink */ }
          try {
            writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
            return true;
          } catch {
            return false; // lost the race to another process
          }
        }
      }
    } catch { /* can't read lock — fall through to safe default */ }
    return false;
  }
}

export async function handleSessionStart(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin || "{}") as Record<string, unknown>;
  } catch {
    return { exitCode: 0, stdout: "" };
  }

  const sessionId = (input.session_id as string | undefined) ?? "";
  if (sessionId && !tryAcquireSessionLock(sessionId)) {
    return { exitCode: 0, stdout: "" };
  }

  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {

    // SessionStart scavenge: prune old processed events and trigger promotion for unprocessed ones
    try {
      const { EventsDb } = await import("./events-db.js");
      const { eventsDbPath } = await import("../db/events-path.js");
      const cwd = (input.cwd as string | undefined) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      const eventsDb = new EventsDb(eventsDbPath(cwd));
      try {
        eventsDb.pruneProcessed(7);
        eventsDb.pruneUnprocessed(10_000, 30);
        eventsDb.pruneErrorLog(30);
        const unprocessed = eventsDb.getUnprocessed(1);
        if (unprocessed.length > 0) {
          const { firePromoteEventsRequest } = await import("./session-end.js");
          firePromoteEventsRequest(daemonPort, { cwd });
        }
      } finally {
        eventsDb.close();
      }
    } catch {
      // Silent fail — scavenge is best-effort
    }

    const result = await client.post<{ context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> }>("/restore", input);
    let stdout = result.context || "";

    if (result.insights && result.insights.length > 0) {
      const insightsBlock = result.insights
        .map((i) => `- ${i.content} (confidence: ${i.confidence})`)
        .join("\n");
      stdout += `\n<learned-insights source="passive-capture">\nRecent learnings from your previous sessions:\n${insightsBlock}\n</learned-insights>`;
    }

    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
