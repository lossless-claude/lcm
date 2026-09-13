import { findUncompacted } from "../../batch-compact.js";
import { fireCompactRequest } from "../../hooks/session-end.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { validateCwd } from "../validate-cwd.js";
import { compactingSessionsFor } from "./compact.js";

/**
 * SessionStart's catch-up sweep: a conversation of the same project that ended
 * without `SessionEnd` (crash, killed terminal, daemon down at exit) keeps its
 * raw messages uncompacted forever otherwise — nothing else revisits it.
 *
 * Runs entirely on the daemon side so the calling hook only fires one
 * fire-and-forget request (see `src/hooks/restore.ts`) and pays no latency for
 * the selection work below. Requires the daemon's own listening port to reuse
 * `fireCompactRequest` unchanged, exactly as a hook would call it.
 */
export function createSessionStartCompactHandler(config: DaemonConfig, daemonPort: number): RouteHandler {
  return async (_req, res, body) => {
    let input: { session_id?: unknown; cwd?: string };
    try {
      const parsed: unknown = JSON.parse(body || "{}");
      // `null` and `[1]` are valid JSON and would reach the reads below as a 500.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed as { session_id?: unknown; cwd?: string };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
    if (!sessionId) {
      // Without it the filter below excludes nothing and the sweep can queue the very
      // conversation that is starting.
      sendJson(res, 400, { error: "session_id required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd as string);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const cap = config.compaction.autoCompactSessionStartMax;
    if (config.hooks?.disableAutoCompact || cap <= 0) {
      sendJson(res, 200, { queued: 0 });
      return;
    }

    // The caller is a fire-and-forget hook, and `findUncompacted` aggregates over every
    // message and summary of the project: answer first, scan on a later turn. That takes the
    // scan off this request's latency, not off the event loop — it is synchronous, so while
    // it runs the daemon still serves nothing else. Moving it to a worker is issue #491.
    sendJson(res, 202, { queued: "scheduled" });

    setImmediate(() => {
      let candidates;
      try {
        candidates = findUncompacted(config.compaction.autoCompactMinTokens, false, cwd);
      } catch (err) {
        console.error(`session-start-compact: selection failed for ${cwd}: ${err instanceof Error ? err.message : err}`);
        return;
      }

      const inFlight = new Set(compactingSessionsFor(cwd));
      const eligible = candidates
        .filter((c) => c.sessionId !== sessionId && !inFlight.has(c.sessionId))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)) // oldest first: drain a backlog over several starts
        .slice(0, cap);

      for (const conv of eligible) {
        fireCompactRequest(daemonPort, {
          session_id: conv.sessionId,
          cwd: conv.cwd,
          skip_ingest: true,
          client: "claude",
        });
      }
    });
  };
}
