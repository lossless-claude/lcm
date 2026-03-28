import { getPoolStats } from "../../db/connection.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";

export function createPoolStatsHandler(): RouteHandler {
  return async (_req, res, _body) => {
    try {
      const stats = getPoolStats();
      sendJson(res, 200, stats);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "pool stats failed" });
    }
  };
}
