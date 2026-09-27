import { statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { functionHooksOwnSession } from "./session-claim.js";
import type { LcmPaths } from "../lcm-paths.js";
import { observeHook } from "./observe.js";

export interface SnapshotDeps {
  statSync: (path: string) => { mtimeMs: number } | null;
  writeFileSync: (path: string, data: string) => void;
  snapshotIntervalSec: number;
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
}

function defaultStatSync(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export async function handleSessionSnapshot(
  stdin: string,
  paths: LcmPaths,
  deps?: Partial<SnapshotDeps>,
): Promise<{ exitCode: number; stdout: string }> {
  let cwd: string | undefined;
  let sessionId = "";
  let captureConfirmed = false;
  const observeExecution = (status: "completed" | "delegated" | "deferred" | "failed", reason = "") =>
    observeHook(cwd, {
      sessionId, harness: "claude-command", hook: "Stop", operation: "capture", kind: "execution", status, reason,
      ...(status === "failed" ? { failureCode: reason } : {}),
    }, paths);
  const observeDelivery = (status: "accepted" | "rejected" | "unconfirmed", reason = "") =>
    observeHook(cwd, {
      sessionId, harness: "claude-command", hook: "Stop", operation: "capture", kind: "delivery", status, reason,
      ...(status === "rejected" ? { failureCode: reason } : {}),
    }, paths);
  try {
    const input = JSON.parse(stdin || "{}");
    const { session_id, transcript_path } = input;
    sessionId = typeof session_id === "string" ? session_id : "";
    cwd = typeof input.cwd === "string" ? input.cwd : undefined;
    if (!session_id || !cwd || !transcript_path) {
      if (cwd) observeExecution("failed", "invalid-input");
      return { exitCode: 0, stdout: "" };
    }

    // The module ingests on turn.complete while it holds the session; a second ingest
    // per turn from here would only parse the same transcript twice.
    if (functionHooksOwnSession(session_id)) {
      observeExecution("delegated", "function-hook");
      return { exitCode: 0, stdout: "" };
    }

    const safeSessionId = session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cursorDir = paths.tmpDir;
    mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
    const cursorPath = join(cursorDir, `snap-${safeSessionId}.json`);
    const _statSync = deps?.statSync ?? defaultStatSync;
    let intervalSec = deps?.snapshotIntervalSec;
    if (intervalSec === undefined) {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const config = loadDaemonConfig(paths.configPath);
      intervalSec = config.hooks?.snapshotIntervalSec ?? 60;
    }

    // Throttle: stat cursor mtime, skip if within interval
    let stat: { mtimeMs: number } | null = null;
    try {
      stat = _statSync(cursorPath);
    } catch {
      // No cursor file — treat as expired
    }
    if (stat && (Date.now() - stat.mtimeMs) < intervalSec * 1000) {
      observeExecution("deferred", "throttled");
      return { exitCode: 0, stdout: "" };
    }

    // POST to /ingest — daemon handles delta via storedCount
    const _post = deps?.post;
    if (_post) {
      const response = await _post("/ingest", { session_id, cwd, transcript_path });
      if (response && typeof response === "object") {
        const result = response as { ok?: boolean; status?: number };
        if (result.ok === false || (typeof result.status === "number" && result.status >= 400)) {
          throw Object.assign(new Error("ingest rejected"), { status: result.status ?? 500 });
        }
      }
    } else {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { readFileSync: _readFileSync } = await import("node:fs");
      const config = loadDaemonConfig(paths.configPath);
      const port = config.daemon?.port ?? 3737;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Read token from token file if available (silent fallback if not found)
      let token: string | null = null;
      try {
        const raw = _readFileSync(paths.tokenPath, "utf-8").trim();
        token = raw || null;
      } catch {
        // Token file not found — auth not yet set up, proceed without it
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(`${baseUrl}/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id, cwd, transcript_path }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Object.assign(new Error("ingest rejected"), { status: response.status });
    }
    captureConfirmed = true;
    observeDelivery("accepted");
    observeExecution("completed");

    // Touch cursor file
    const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
    _writeFileSync(cursorPath, JSON.stringify({ ts: Date.now() }));
    try { chmodSync(cursorPath, 0o600); } catch { /* non-fatal */ }

    // Best-effort promote-events flush
    try {
      const { loadDaemonConfig: _loadConfig } = await import("../daemon/config.js");
      const _config = _loadConfig(paths.configPath);
      const port = _config.daemon?.port ?? 3737;
      const { firePromoteEventsRequest } = await import("./daemon-requests.js");
      firePromoteEventsRequest(port, { cwd: input.cwd }, paths);
    } catch {
      // Best-effort only
    }

    return { exitCode: 0, stdout: "" };
  } catch (err) {
    if (captureConfirmed) {
      observeHook(cwd, { sessionId, harness: "claude-command", hook: "Stop",
        operation: "retry-timer", kind: "execution", status: "failed",
        reason: "write-error", failureCode: "write-error" }, paths);
      return { exitCode: 0, stdout: "" };
    }
    const status = (err as { status?: unknown })?.status;
    observeDelivery(typeof status === "number" ? "rejected" : "unconfirmed",
      typeof status === "number" ? `http-${status}` : err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport");
    return { exitCode: 0, stdout: "" };
  }
}
