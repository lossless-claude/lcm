import { collectStats } from "../../stats.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { LcmPaths } from "../../lcm-paths.js";

export function createStatsHandler(paths: LcmPaths): RouteHandler {
  return async (_req, res, _body) => {
    try {
      const stats = collectStats(paths);
      sendJson(res, 200, stats);
    } catch {
      sendJson(res, 500, { error: "Stats collection failed" });
    }
  };
}
