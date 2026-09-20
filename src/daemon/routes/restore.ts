import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { createRestore, type Insight } from "../restore/index.js";

/**
 * POST /restore — the harness's SessionStart payload, answered by the restore module
 * (`src/daemon/restore/`).
 *
 * This file owns the wire only: JSON in, `{ context, insights? }` out, and the status the
 * outcome names. How the context is assembled is not decided here.
 */
export function createRestoreHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
  const restore = createRestore(config, paths);
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}") as Record<string, unknown>;
      const outcome = await restore({
        client: input.client,
        sessionId: input.session_id,
        source: input.source,
        cwd: input.cwd,
      });

      if (outcome.kind !== "context") {
        sendJson(res, outcome.kind === "invalid-cwd" ? 400 : 500, { error: outcome.message });
        return;
      }

      const responseBody: { context: string; insights?: Insight[] } = { context: outcome.context };
      if (outcome.insights) responseBody.insights = [...outcome.insights];
      sendJson(res, 200, responseBody);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}