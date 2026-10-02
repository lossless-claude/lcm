import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { functionHooksOwnSession } from "./session-claim.js";
import { fireSessionStartCompactRequest } from "./daemon-requests.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import type { LcmPaths } from "../lcm-paths.js";
import { observeHook } from "./observe.js";

/** Deadline for the /restore call — SessionStart blocks the session until this hook returns. */
const RESTORE_TIMEOUT_MS = 10_000;

/** Returns true if lock was acquired, false if another live process holds it. */
function tryAcquireSessionLock(sessionId: string): boolean {
  const lockPath = join(tmpdir(), `lcm-restore-${sessionId}.lock`);
  try {
    writeFileSync(lockPath, process.pid.toString(), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — check if the owner process is still alive
    try {
      const ownerPid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
      if (!isNaN(ownerPid)) {
        try {
          process.kill(ownerPid, 0); // throws if process is dead
          return false; // owner alive, genuine dedup
        } catch {
          // Owner dead — take over the lock
          writeFileSync(lockPath, process.pid.toString());
          return true;
        }
      }
    } catch { /* can't read lock — fall through to safe default */ }
    return false;
  }
}

/** Hook stdin payload — only the fields this hook reads are typed; the rest is forwarded verbatim. */
type SessionStartInput = {
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
};

export async function handleSessionStart(stdin: string, client: DaemonClient, paths: LcmPaths, port?: number): Promise<{ exitCode: number; stdout: string }> {
  let input: SessionStartInput;
  try {
    input = (JSON.parse(stdin || "{}") ?? {}) as SessionStartInput;
  } catch {
    return { exitCode: 0, stdout: "" }; // malformed stdin must never block session start
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const observe = (status: "completed" | "delegated" | "deferred" | "failed", reason: string) =>
    observeHook(input.cwd, { sessionId, harness: "claude-command", hook: "SessionStart",
      operation: "restore", kind: "execution", status, reason,
      ...(status === "failed" ? { failureCode: reason } : {}) }, paths);
  const observeDelivery = (status: "accepted" | "rejected" | "unconfirmed", reason = "") =>
    observeHook(input.cwd, { sessionId, harness: "claude-command", hook: "SessionStart",
      operation: "restore", kind: "delivery", status, reason,
      ...(status === "rejected" ? { failureCode: reason } : {}) }, paths);

  // The module restores through prompt.context and scavenges through the daemon while it
  // holds the session; printing the same context here would inject it twice.
  if (functionHooksOwnSession(sessionId)) {
    observe("delegated", "function-hook");
    return { exitCode: 0, stdout: "" };
  }

  if (sessionId && !tryAcquireSessionLock(sessionId)) {
    observe("delegated", "restore-lock");
    return { exitCode: 0, stdout: "" };
  }

  const daemonPort = port ?? 3737;
  const pidFilePath = paths.pidPath;
  try {
    const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000, expectedVersion: PKG_VERSION });
    if (!connected) {
      observe("deferred", "daemon-unavailable");
      return { exitCode: 0, stdout: "" };
    }
    let result: { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> };
    try {
      result = await client.post<typeof result>("/restore", input, { timeoutMs: RESTORE_TIMEOUT_MS });
    } catch (error) {
      const httpStatus = (error as { status?: unknown })?.status;
      observeDelivery(typeof httpStatus === "number" ? "rejected" : "unconfirmed",
        typeof httpStatus === "number" ? `http-${httpStatus}` : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport");
      return { exitCode: 0, stdout: "" };
    }
    observeDelivery("accepted");
    let stdout = result.context || "";

    if (result.insights && result.insights.length > 0) {
      const seen = new Set<string>();
      const insightsBlock = result.insights
        .filter((i) => !seen.has(i.content) && seen.add(i.content))
        .map((i) => `- ${i.content} (confidence: ${i.confidence})`)
        .join("\n");
      stdout += `\n<learned-insights source="passive-capture">\nRecent learnings from your previous sessions:\n${insightsBlock}\n</learned-insights>`;
    }

    // Fire-and-forget: catch up any conversation of this project left uncompacted
    // by a session that ended without SessionEnd. Never awaited, so it adds no
    // latency here; the daemon does the selection and per-conversation compaction.
    if (input.cwd) {
      try {
        fireSessionStartCompactRequest(daemonPort, { cwd: input.cwd, session_id: sessionId }, paths);
        observeHook(input.cwd, { sessionId, harness: "claude-command", hook: "SessionStart",
          operation: "catch-up", kind: "delivery", status: "submitted" }, paths);
      } catch {
        observeHook(input.cwd, { sessionId, harness: "claude-command", hook: "SessionStart",
          operation: "catch-up", kind: "delivery", status: "rejected", reason: "send-error",
          failureCode: "send-error" }, paths);
      }
    }

    observe("completed", stdout ? "context" : "no-context");
    return { exitCode: 0, stdout };
  } catch {
    observe("failed", "restore-error");
    return { exitCode: 0, stdout: "" };
  }
}
