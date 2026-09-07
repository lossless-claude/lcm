// src/db/events-stats.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./events-path.js";
import { EventsDb } from "../hooks/events-db.js";

export interface EventStats {
  captured: number;
  unprocessed: number;
  errors: number;
  lastCapture: string | null;
  /** Sidecar DBs actually read; smaller than `total` when the scan was capped or timed out. */
  scanned: number;
  /** Sidecar DBs present on disk. */
  total: number;
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

/** Sidecar DB filenames, most recently modified first, so a capped scan covers the active projects. */
function listEventDbsNewestFirst(dir: string): string[] {
  const files = readdirSync(dir).filter(f => f.endsWith(".db"));
  const mtime = (f: string): number => {
    try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; }
  };
  return files
    .map(f => ({ f, m: mtime(f) }))
    .sort((a, b) => b.m - a.m)
    .map(({ f }) => f);
}

/**
 * Scan all sidecar DBs and aggregate event stats.
 * Used by both lcm doctor and lcm stats.
 * @param timeoutMs Total time budget for the scan (default 2000ms)
 */
export function collectEventStats(timeoutMs = 2000): EventStats {
  const result: EventStats = { captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 0, total: 0 };
  const dir = eventsDir();

  let files: string[];
  try {
    files = listEventDbsNewestFirst(dir);
  } catch {
    return result; // events dir doesn't exist
  }
  result.total = files.length;

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

  result.scanned = scanned;
  return result;
}

/**
 * Detailed scan for verbose doctor output — returns per-project breakdown + recent errors.
 */
export function collectDetailedEventStats(timeoutMs = 2000): DetailedEventStats {
  const result: DetailedEventStats = {
    captured: 0, unprocessed: 0, errors: 0, lastCapture: null, scanned: 0, total: 0,
    projects: [], recentErrors: [],
  };
  const dir = eventsDir();

  let files: string[];
  try {
    files = listEventDbsNewestFirst(dir);
  } catch {
    return result;
  }
  result.total = files.length;

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

  result.scanned = scanned;
  // Sort and limit recent errors across all DBs
  result.recentErrors.sort((a, b) => b.created_at.localeCompare(a.created_at));
  result.recentErrors = result.recentErrors.slice(0, 5);

  return result;
}
