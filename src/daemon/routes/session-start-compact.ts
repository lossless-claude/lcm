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
    const input = JSON.parse(body || "{}");
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const cap = config.compaction.autoCompactSessionStartMax;
    if (config.hooks?.disableAutoCompact || cap <= 0) {
      sendJson(res, 200, { queued: 0 });
      return;
    }

    let candidates;
    try {
      candidates = findUncompacted(config.compaction.autoCompactMinTokens, false, cwd);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "selection failed" });
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

    sendJson(res, 200, { queued: eligible.length });
  };
}
