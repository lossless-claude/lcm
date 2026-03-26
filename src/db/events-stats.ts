// src/db/events-stats.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./events-path.js";
import { EventsDb } from "../hooks/events-db.js";

export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
}

export interface DetailedEventStats extends EventStats {
  projects: Array<{
    file: string;
    captured: number;
    unprocessed: number;
    lastCapture: string | null;
  }>;
  recentErrors: Array<{ created_at: string; hook: string; error: string }>;
}

const MAX_DBS = 50;

/**
 * Scan all sidecar DBs and aggregate event stats.
 * Used by both lcm doctor and lcm stats.
 * @param timeoutMs Total time budget for the scan (default 2000ms)
 */
export function collectEventStats(timeoutMs = 2000): EventStats {
  const result: EventStats = { captured: 0, unprocessed: 0, errors: 0, lastCapture: null };
  const dir = eventsDir();

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".db"));
  } catch {
    return result; // events dir doesn't exist
  }

  const deadline = Date.now() + timeoutMs;
  let scanned = 0;

  for (const file of files) {
    if (scanned >= MAX_DBS || Date.now() >= deadline) break;
    try {
      const db = new EventsDb(join(dir, file));
      // Override busy_timeout for scan connections (500ms instead of default 5000ms)
      db.raw().exec("PRAGMA busy_timeout = 500");
      try {
        const stats = db.getHealthStats();
        result.captured += stats.totalEvents;
        result.unprocessed += stats.unprocessed;
        result.errors += stats.errors;
        if (stats.lastCapture && (!result.lastCapture || stats.lastCapture > result.lastCapture)) {
          result.lastCapture = stats.lastCapture;
        }
      } finally {
        db.close();
      }
      scanned++;
    } catch {
      scanned++;
    }
  }

  return result;
}

/**
 * Detailed scan for verbose doctor output — returns per-project breakdown + recent errors.
 */
export function collectDetailedEventStats(timeoutMs = 2000): DetailedEventStats {
  const result: DetailedEventStats = {
    captured: 0, unprocessed: 0, errors: 0, lastCapture: null,
    projects: [], recentErrors: [],
  };
  const dir = eventsDir();

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".db"));
  } catch {
    return result;
  }

  const deadline = Date.now() + timeoutMs;
  let scanned = 0;

  for (const file of files) {
    if (scanned >= MAX_DBS || Date.now() >= deadline) break;
    try {
      const db = new EventsDb(join(dir, file));
      db.raw().exec("PRAGMA busy_timeout = 500");
      try {
        const stats = db.getHealthStats();
        result.captured += stats.totalEvents;
        result.unprocessed += stats.unprocessed;
        result.errors += stats.errors;
        if (stats.lastCapture && (!result.lastCapture || stats.lastCapture > result.lastCapture)) {
          result.lastCapture = stats.lastCapture;
        }
        result.projects.push({
          file,
          captured: stats.totalEvents,
          unprocessed: stats.unprocessed,
          lastCapture: stats.lastCapture,
        });
        // Collect recent errors for verbose display (exclude maintenance/pruning entries)
        const errors = db.raw().prepare(
          "SELECT created_at, hook, error FROM error_log WHERE hook NOT LIKE 'maintenance:%' ORDER BY id DESC LIMIT 5"
        ).all() as Array<{ created_at: string; hook: string; error: string }>;
        result.recentErrors.push(...errors);
      } finally {
        db.close();
      }
      scanned++;
    } catch {
      scanned++;
    }
  }

  // Sort and limit recent errors across all DBs
  result.recentErrors.sort((a, b) => b.created_at.localeCompare(a.created_at));
  result.recentErrors = result.recentErrors.slice(0, 5);

  return result;
}
