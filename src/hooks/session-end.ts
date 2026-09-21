import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { loadDaemonConfig } from "../daemon/config.js";
import {
  fireCompactRequest,
  firePromoteEventsRequest,
  firePromoteRequest,
  fireSessionCompleteRequest,
} from "./daemon-requests.js";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";

/**
 * Deadline for the `202` from `/session-end`, and — on a 404 fallback — for the
 * `/ingest` it runs itself. The host gives SessionEnd hooks a shared budget of
 * about 1.5s, so the daemon must acknowledge, not finish.
 */
const SESSION_END_TIMEOUT_MS = 1_000;
/** Floor for the wait after the health probe (and, on fallback, the first POST) has eaten into the budget. */
const MIN_ACK_TIMEOUT_MS = 100;

/**
 * Runs the sequence a hook process ran before `/session-end` existed, for a
 * compatible daemon of an earlier patch that answers `404` to it: awaits
 * `/ingest` within what is left of the budget, then fires compact, promote,
 * promote-events and session-complete the same unref'd, unobserved way the
 * daemon's own post-ingest sequence does (`src/daemon/routes/session-end.ts`).
 * If `/ingest` does not return in time the four are not sent; the failure is
 * logged, not thrown, so the hook still exits 0.
 */
async function runLegacyFallback(
  client: DaemonClient,
  input: Record<string, unknown>,
  paths: LcmPaths,
  daemonPort: number,
  remainingMs: number,
): Promise<void> {
  const cwd = input.cwd as string | undefined;
  const sessionId = input.session_id as string | undefined;
  const { safeLogError } = await import("./hook-errors.js");
  try {
    const ingested = await client.post<{ ingested?: number; redacted?: number; redactedCategories?: string[] }>(
      "/ingest", input, { timeoutMs: remainingMs },
    );
    const config = loadDaemonConfig(paths.configPath);
    if (config.security?.notify_on_filter !== false && ingested.redacted) {
      const categories = (ingested.redactedCategories ?? []).join(", ");
      safeLogError("session-end:redaction-notice", `filtered sensitive data from history (pattern: ${categories})`, { cwd, sessionId, paths });
    }
    if (!config.hooks?.disableAutoCompact) {
      fireCompactRequest(daemonPort, { session_id: sessionId, cwd, skip_ingest: true, client: "claude" }, paths);
    }
    firePromoteRequest(daemonPort, { cwd }, paths);
    firePromoteEventsRequest(daemonPort, { cwd }, paths);
    // `ingested` is this call's delta, not the session total.
    fireSessionCompleteRequest(daemonPort, { session_id: sessionId, cwd, message_count: ingested.ingested ?? 0 }, paths);
  } catch (fallbackErr) {
    safeLogError("session-end", fallbackErr, { cwd, sessionId, paths });
  }
}

export async function handleSessionEnd(
  stdin: string,
  client: DaemonClient,
  paths: LcmPaths,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = paths.pidPath;
  const started = Date.now();
  // Never spawn a daemon here, only talk to one that is already up. The Stop hook's
  // session-snapshot has been ingesting incrementally, and SessionStart sweeps what
  // this misses.
  const { connected } = await ensureDaemon({
    port: daemonPort,
    pidFilePath,
    spawnTimeoutMs: 0,
    noSpawn: true,
    expectedVersion: PKG_VERSION,
  });
  if (!connected) return { exitCode: 0, stdout: "" };

  // One request; the daemon runs ingest → compact → promote → promote-events →
  // session-complete on its own (`src/daemon/routes/session-end.ts`), so a hook
  // killed by the host loses nothing. The health probe above shares the budget.
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stdin || "{}");
    // Valid JSON that is not an object (`null`, a list) must still fail open below.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    const remainingMs = Math.max(MIN_ACK_TIMEOUT_MS, SESSION_END_TIMEOUT_MS - (Date.now() - started));
    await client.post("/session-end", input, { timeoutMs: remainingMs });
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      // A compatible daemon of an earlier patch has no /session-end: run the
      // sequence the hook ran before it was handed to the daemon, within what
      // is left of the same budget.
      const remainingMs = Math.max(MIN_ACK_TIMEOUT_MS, SESSION_END_TIMEOUT_MS - (Date.now() - started));
      await runLegacyFallback(client, input, paths, daemonPort, remainingMs);
    } else {
      // Loaded here, not at module top: hook-errors pulls in node:sqlite, whose
      // experimental warning would otherwise reach stderr on every hook start.
      // Anything else must not block exit, but leaves a trace — the terminal is gone by now.
      const { safeLogError } = await import("./hook-errors.js");
      safeLogError("session-end", err, { cwd: input.cwd as string | undefined, sessionId: input.session_id as string | undefined, paths });
    }
  }
  return { exitCode: 0, stdout: "" };
}
