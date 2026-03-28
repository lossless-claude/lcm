// src/hooks/hook-errors.ts
import { EventsDb } from "./events-db.js";
import { eventsDbPath } from "../db/events-path.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";

/** Returns the log path — overridable via LCM_LOG_PATH env var for test isolation. */
export function getLogPath(): string {
  return process.env.LCM_LOG_PATH ?? join(homedir(), ".lossless-claude", "logs", "events.log");
}

let dbCircuitOpen = false;

/** Reset circuit breaker — for testing only. */
export function _resetCircuitBreaker(): void {
  dbCircuitOpen = false;
}

/**
 * Three-layer error fence for hook processes.
 * Layer 1: Sidecar DB error_log table (queryable by doctor/stats)
 * Layer 2: Flat file ~/.lossless-claude/logs/events.log
 * Layer 3: Swallow silently — hooks must never crash
 */
export function safeLogError(
  hook: string,
  error: unknown,
  opts: { cwd?: string; sessionId?: string },
): void {
  // Layer 1: Sidecar DB (skip if cwd missing or circuit open)
  if (opts.cwd && !dbCircuitOpen) {
    try {
      const db = new EventsDb(eventsDbPath(opts.cwd));
      try {
        db.logHookError(hook, error, opts.sessionId);
      } finally {
        db.close();
      }
      return;
    } catch {
      dbCircuitOpen = true; // skip DB on subsequent calls this process
    }
  }

  // Layer 2: Flat file (include cwd for diagnosing DB-skip cases)
  try {
    const logPath = getLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      error: error instanceof Error ? error.message : String(error),
      session_id: opts.sessionId,
      cwd: opts.cwd,
    }) + "\n");
    return;
  } catch { /* file failed — fall through */ }

  // Layer 3: Swallow silently — hooks must never crash
}
