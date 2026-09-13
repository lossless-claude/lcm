import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { functionHooksOwnSession } from "./session-claim.js";
import { fireSessionStartCompactRequest } from "./session-end.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, readFileSync } from "node:fs";
import type { LcmPaths } from "../lcm-paths.js";

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

  // The module restores through prompt.context and scavenges through the daemon while it
  // holds the session; printing the same context here would inject it twice.
  if (functionHooksOwnSession(sessionId)) return { exitCode: 0, stdout: "" };

  if (sessionId && !tryAcquireSessionLock(sessionId)) {
    return { exitCode: 0, stdout: "" };
  }

  const daemonPort = port ?? 3737;
  const pidFilePath = paths.pidPath;
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000, expectedVersion: PKG_VERSION });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const result = await client.post<{ context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> }>("/restore", input, { timeoutMs: RESTORE_TIMEOUT_MS });
    let stdout = result.context || "";

    if (result.insights && result.insights.length > 0) {
      const insightsBlock = result.insights
        .map((i) => `- ${i.content} (confidence: ${i.confidence})`)
        .join("\n");
      stdout += `\n<learned-insights source="passive-capture">\nRecent learnings from your previous sessions:\n${insightsBlock}\n</learned-insights>`;
    }

    // Fire-and-forget: catch up any conversation of this project left uncompacted
    // by a session that ended without SessionEnd. Never awaited, so it adds no
    // latency here; the daemon does the selection and per-conversation compaction.
    if (input.cwd) {
      fireSessionStartCompactRequest(daemonPort, { cwd: input.cwd, session_id: sessionId }, paths);
    }

    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
