import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";

export async function handleSessionStart(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");

    // SessionStart scavenge: prune old processed events and trigger promotion for unprocessed ones
    try {
      const { EventsDb } = await import("./events-db.js");
      const { eventsDbPath } = await import("../db/events-path.js");
      const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
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
