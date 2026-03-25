import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  deps?: Partial<SnapshotDeps>,
): Promise<{ exitCode: number; stdout: string }> {
  try {
    const input = JSON.parse(stdin || "{}");
    const { session_id, cwd, transcript_path } = input;
    if (!session_id || !cwd || !transcript_path) {
      return { exitCode: 0, stdout: "" };
    }

    const safeSessionId = session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cursorDir = join(homedir(), ".lossless-claude", "tmp");
    mkdirSync(cursorDir, { recursive: true });
    const cursorPath = join(cursorDir, `snap-${safeSessionId}.json`);
    const _statSync = deps?.statSync ?? defaultStatSync;
    let intervalSec = deps?.snapshotIntervalSec;
    if (intervalSec === undefined) {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
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
      return { exitCode: 0, stdout: "" };
    }

    // POST to /ingest — daemon handles delta via storedCount
    const _post = deps?.post;
    if (_post) {
      await _post("/ingest", { session_id, cwd, transcript_path });
    } else {
      const { loadDaemonConfig } = await import("../daemon/config.js");
      const { readFileSync: _readFileSync } = await import("node:fs");
      const { homedir: _homedir } = await import("node:os");
      const config = loadDaemonConfig(join(_homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const baseUrl = `http://127.0.0.1:${port}`;

      // Read token from token file if available (silent fallback if not found)
      let token: string | null = null;
      try {
        const tokenPath = join(_homedir(), ".lossless-claude", "daemon.token");
        const raw = _readFileSync(tokenPath, "utf-8").trim();
        token = raw || null;
      } catch {
        // Token file not found — auth not yet set up, proceed without it
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      await fetch(`${baseUrl}/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id, cwd, transcript_path }),
      });
    }

    // Touch cursor file
    const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
    _writeFileSync(cursorPath, JSON.stringify({ ts: Date.now() }));

    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
