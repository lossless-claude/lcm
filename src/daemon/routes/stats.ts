import { collectStats } from "../../stats.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";

export function createStatsHandler(): RouteHandler {
  return async (_req, res, _body) => {
    try {
      const stats = collectStats();
      sendJson(res, 200, stats);
    } catch {
      sendJson(res, 500, { error: "Stats collection failed" });
    }
  };
}
