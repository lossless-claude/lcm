import type { DaemonClient } from "../daemon/client.js";
import { loadDaemonConfig } from "../daemon/config.js";
import {
  fireCompactRequest,
  firePromoteEventsRequest,
  firePromoteRequest,
  fireSessionCompleteRequest,
} from "./daemon-requests.js";
import type { LcmPaths } from "../lcm-paths.js";
import { observeHook } from "./observe.js";

/** Leave room for Node startup inside the host's shared ~1.5s exit budget. */
const SUBMISSION_TIMEOUT_MS = 200;
/** After the body is flushed, only a responsive daemon's 202 or 404 is awaited. */
const RESPONSE_GRACE_MS = 100;
/** A responsive 404 may use only what remains of the same exit budget. */
const SESSION_END_TIMEOUT_MS = SUBMISSION_TIMEOUT_MS + RESPONSE_GRACE_MS;

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
  const signal = AbortSignal.timeout(remainingMs);
  const { safeLogError } = await import("./hook-errors.js");
  try {
    let ingested: { ingested?: number; redacted?: number; redactedCategories?: string[] };
    try {
      ingested = await client.post<typeof ingested>("/ingest", input, { timeoutMs: remainingMs, signal });
    } catch (error) {
      const httpStatus = (error as { status?: unknown })?.status;
      const rejected = typeof httpStatus === "number";
      const reason = rejected ? `http-${httpStatus}` : signal.aborted || error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport";
      observeHook(cwd, { sessionId: sessionId ?? "", harness: "claude-command", hook: "SessionEnd",
        operation: "capture", kind: "delivery", status: rejected ? "rejected" : "unconfirmed", reason,
        ...(rejected ? { failureCode: reason } : {}) }, paths);
      safeLogError("session-end", error, { cwd, sessionId, paths });
      return;
    }
    observeHook(cwd, { sessionId: sessionId ?? "", harness: "claude-command", hook: "SessionEnd",
      operation: "capture", kind: "delivery", status: "accepted", reason: "legacy-fallback" }, paths);
    observeHook(cwd, { sessionId: sessionId ?? "", harness: "claude-command", hook: "SessionEnd",
      operation: "capture", kind: "execution", status: "completed", reason: "legacy-fallback" }, paths);
    const config = loadDaemonConfig(paths.configPath);
    if (config.security?.notify_on_filter !== false && ingested.redacted) {
      const categories = (ingested.redactedCategories ?? []).join(", ");
      safeLogError("session-end:redaction-notice", `filtered sensitive data from history (pattern: ${categories})`, { cwd, sessionId, paths });
    }
    if (!config.hooks?.disableAutoCompact) {
      fireCompactRequest(daemonPort, { session_id: sessionId, cwd, skip_ingest: true, work_class: "live", client: "claude" }, paths);
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
  const started = Date.now();
  let observedInput: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(stdin || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) observedInput = parsed;
  } catch { /* The route still validates the original payload. */ }
  const cwd = typeof observedInput.cwd === "string" ? observedInput.cwd : undefined;
  const sessionId = typeof observedInput.session_id === "string" ? observedInput.session_id : "";
  const observeDelivery = (status: "submitted" | "accepted" | "rejected" | "unconfirmed", reason = "") =>
    observeHook(cwd, { sessionId, harness: "claude-command", hook: "SessionEnd",
      operation: "session-end", kind: "delivery", status, reason,
      ...(status === "rejected" ? { failureCode: reason } : {}) }, paths);
  // Post directly: a refused connection fails open without spawning, and a
  // blocked daemon must not consume the budget on a separate health probe.
  let input: Record<string, unknown> = {};
  let submitted = false;
  const controller = new AbortController();
  let deadline = setTimeout(() => controller.abort(), SUBMISSION_TIMEOUT_MS);
  try {
    const parsed: unknown = JSON.parse(stdin || "{}");
    // Valid JSON that is not an object (`null`, a list) must still fail open below.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    await client.post("/session-end", input, {
      signal: controller.signal,
      onSubmitted: () => {
        submitted = true;
        clearTimeout(deadline);
        deadline = setTimeout(() => controller.abort(), RESPONSE_GRACE_MS);
      },
    });
    observeDelivery("accepted");
  } catch (err) {
    if (controller.signal.aborted && submitted) {
      // Flushing establishes submission, not acceptance or completed Capture.
      observeDelivery("submitted", "response-grace");
    } else if ((err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED") {
      observeDelivery("unconfirmed", "daemon-unavailable");
    } else if ((err as { status?: number }).status === 404) {
      clearTimeout(deadline);
      observeDelivery("rejected", "http-404");
      // A compatible daemon of an earlier patch has no /session-end: run the
      // sequence the hook ran before it was handed to the daemon, within what
      // is left of the same budget.
      const remainingMs = Math.max(1, SESSION_END_TIMEOUT_MS - (Date.now() - started));
      await runLegacyFallback(client, input, paths, daemonPort, remainingMs);
    } else {
      const status = (err as { status?: unknown })?.status;
      observeDelivery(typeof status === "number" ? "rejected" : "unconfirmed",
        typeof status === "number" ? `http-${status}` : controller.signal.aborted || err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport");
      // Loaded here, not at module top: hook-errors pulls in node:sqlite, whose
      // experimental warning would otherwise reach stderr on every hook start.
      // Anything else must not block exit, but leaves a trace — the terminal is gone by now.
      const { safeLogError } = await import("./hook-errors.js");
      safeLogError("session-end", err, { cwd: input.cwd as string | undefined, sessionId: input.session_id as string | undefined, paths });
    }
  } finally {
    clearTimeout(deadline);
  }
  return { exitCode: 0, stdout: "" };
}
