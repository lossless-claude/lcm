import type { LcmPaths } from "../../lcm-paths.js";
import { clearReplayState, replaySessionsToClear, type ReplayCommand } from "../../replay-resume.js";
import { projectId } from "../project.js";
import { enqueue, withProjectMutation } from "../project-queue.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { holdSessionCompaction } from "./compact.js";

/** Reset replay state after in-flight summaries finish, while holding their session guards. */
export function createReplayResetHandler(paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}") as { cwd?: unknown; command?: unknown };
    if (typeof input.cwd !== "string" || (input.command !== "import" && input.command !== "compact")) {
      sendJson(res, 400, { error: "cwd and replay command are required" });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }
    const command: ReplayCommand = input.command;
    // Acquire before entering the project queue: a compaction may have yielded
    // its queue turn while the summarizer runs and must be able to reacquire it.
    const releases: Array<() => void> = [];
    try {
      for (const sessionId of replaySessionsToClear(cwd, paths, command)) {
        releases.push(await holdSessionCompaction(sessionId, cwd));
      }
      const result = await enqueue(projectId(cwd), () => withProjectMutation(projectId(cwd), async () => {
        let summaryCount = 0;
        const cleared = await clearReplayState({
          cwd, paths, command, onSummaryCount: (count) => { summaryCount = count; },
        });
        return { cleared, summaryCount };
      }));
      sendJson(res, result.cleared ? 200 : 500, result.cleared ? result : { error: "replay reset failed" });
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
}
