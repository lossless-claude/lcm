import { fireCompactRequest } from "../../hooks/daemon-requests.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import type { DaemonConfig } from "../config.js";
import { validateCwd } from "../validate-cwd.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { compactingSessionsFor } from "./compact.js";
import { createSessionStartCompactScanner } from "../session-start-compact-worker.js";
import { resolveLcmConfig } from "../../db/config.js";
import type { SessionClient } from "../../session-client.js";
import { isSessionClient } from "../../session-client.js";

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
export function createSessionStartCompactHandler(config: DaemonConfig, daemonPort: number, paths: LcmPaths): RouteHandler {
  const scanner = createSessionStartCompactScanner();

  return async (_req, res, body) => {
    let input: { session_id?: unknown; cwd?: string; client?: unknown };
    try {
      const parsed: unknown = JSON.parse(body || "{}");
      // `null` and `[1]` are valid JSON and would reach the reads below as a 500.
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed as { session_id?: unknown; cwd?: string; client?: unknown };
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

    const client: SessionClient = isSessionClient(input.client) ? input.client : "claude";

    // The caller is a fire-and-forget hook. Answer before asking the worker to scan the
    // project's messages and summaries so neither the request nor the daemon's event loop
    // waits for candidate selection.
    sendJson(res, 202, { queued: "scheduled" });

    void scanner.scan(
      paths,
      config.compaction.autoCompactMinTokens,
      cwd,
      { freshTailCount: resolveLcmConfig().freshTailCount },
    ).then((candidates) => {
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
          // The sweep cannot see a conversation's own client (conversations carry
          // none); the caller's is the only signal, and it only picks the summarizer.
          client,
        }, paths);
      }
    }).catch((err: unknown) => {
      console.error(`session-start-compact: selection failed for ${cwd}: ${err instanceof Error ? err.message : err}`);
    });
  };
}
