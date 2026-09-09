import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A hold keeps the daemon down across hook invocations.
 *
 * Stopping the daemon is not enough to get an offline window: every session
 * hook calls `ensureDaemon`, so the next prompt or tool call spawns it again
 * within seconds. Maintenance that must not race a writer — re-labelling rows,
 * a migration, a consistent copy of the stores — has no safe window without
 * this marker.
 */
export type Hold = {
  /** Why the daemon is held down, shown to whoever finds it. */
  reason?: string;
  /** Process that placed the hold; diagnostic only, never trusted for liveness. */
  pid: number;
  /** ISO timestamp after which the hold no longer applies. */
  until: string;
};

/**
 * A hold expires so a forgotten one cannot silently stop memory capture
 * forever. Long enough for the maintenance it exists for, short enough that
 * the worst case is one lost session.
 */
export const DEFAULT_HOLD_MINUTES = 30;

/** The marker lives beside the PID file, so both follow the same base directory. */
export function holdPath(pidFilePath: string): string {
  return join(dirname(pidFilePath), "daemon.hold");
}

/**
 * The hold in force, or null when there is none. An expired or unreadable
 * marker counts as none and is removed, so a corrupt file cannot wedge the
 * daemon down.
 */
export function readHold(pidFilePath: string, now: Date = new Date()): Hold | null {
  const path = holdPath(pidFilePath);
  if (!existsSync(path)) return null;
  let hold: Hold;
  try {
    hold = JSON.parse(readFileSync(path, "utf-8")) as Hold;
  } catch {
    clearHold(pidFilePath);
    return null;
  }
  const until = Date.parse(hold?.until ?? "");
  if (!Number.isFinite(until) || until <= now.getTime()) {
    clearHold(pidFilePath);
    return null;
  }
  return hold;
}

/** Places a hold expiring `minutes` from now, replacing any hold already there. */
export function writeHold(
  pidFilePath: string,
  opts: { minutes?: number; reason?: string; now?: Date } = {},
): Hold {
  const now = opts.now ?? new Date();
  const minutes = opts.minutes ?? DEFAULT_HOLD_MINUTES;
  const hold: Hold = {
    reason: opts.reason,
    pid: process.pid,
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
  const path = holdPath(pidFilePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(hold, null, 2));
  return hold;
}

/** Removes the marker. True when one was there to remove. */
export function clearHold(pidFilePath: string): boolean {
  const path = holdPath(pidFilePath);
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
