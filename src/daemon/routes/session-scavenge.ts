import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { EventsDb } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { createPromoteEventsHandler } from "./promote-events.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import type { DaemonConfig } from "../config.js";

/** Rows kept for events already promoted, and for ones still waiting. */
const PROCESSED_MAX_AGE_DAYS = 7;
const UNPROCESSED_MAX_ROWS = 10_000;
const UNPROCESSED_MAX_AGE_DAYS = 30;
const ERROR_LOG_MAX_AGE_DAYS = 30;

/**
 * POST /session-scavenge — the housekeeping the SessionStart command hook used to do
 * itself: prune the events sidecar and promote anything a previous session left behind.
 *
 * The function-hooks module has no SQLite, so the daemon does it. It also no longer holds
 * up the session: the module fires this and moves on, where the command hook awaited it.
 * Body: `{ cwd }`.
 */
export function createSessionScavengeHandler(config: DaemonConfig): RouteHandler {
  const promoteEvents = createPromoteEventsHandler(config);

  return async (_req, res, body) => {
    let input: { cwd?: unknown };
    try {
      input = JSON.parse(body || "{}") as { cwd?: unknown };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof input.cwd !== "string" || !input.cwd) {
      sendJson(res, 400, { error: "cwd required" });
      return;
    }
    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    let pending = false;
    try {
      const db = new EventsDb(eventsDbPath(cwd));
      try {
        db.pruneProcessed(PROCESSED_MAX_AGE_DAYS);
        db.pruneUnprocessed(UNPROCESSED_MAX_ROWS, UNPROCESSED_MAX_AGE_DAYS);
        db.pruneErrorLog(ERROR_LOG_MAX_AGE_DAYS);
        pending = db.getUnprocessed(1).length > 0;
      } finally {
        db.close();
      }
    } catch (err) {
      // Housekeeping is best-effort; a scavenge that fails must not fail the session.
      safeLogError("session-scavenge", err, { cwd });
      sendJson(res, 200, { pruned: false, promoted: false });
      return;
    }

    sendJson(res, 200, { pruned: true, promoted: pending });

    // After the response, in-process, so the caller is not held: same shape as /tool-event.
    if (pending) {
      const sink = { writeHead: () => {}, end: () => {} } as unknown as Parameters<RouteHandler>[1];
      promoteEvents({} as Parameters<RouteHandler>[0], sink, JSON.stringify({ cwd }))
        .catch(err => safeLogError("session-scavenge", err, { cwd }));
    }
  };
}
