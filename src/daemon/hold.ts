import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
 * marker counts as none. Readers never unlink a marker: a writer may have
 * replaced the observed snapshot with a new hold in the meantime.
 */
export function readHold(pidFilePath: string, now: Date = new Date()): Hold | null {
  const path = holdPath(pidFilePath);
  if (!existsSync(path)) return null;
  let hold: Hold;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || !("pid" in value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || !("until" in value) || typeof value.until !== "string"
      || ("reason" in value && typeof value.reason !== "string")) {
      return null;
    }
    hold = value as Hold;
  } catch {
    return null;
  }
  const until = Date.parse(hold?.until ?? "");
  if (!Number.isFinite(until) || until <= now.getTime()) {
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
  const expiry = new Date(now.getTime() + minutes * 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(expiry.getTime())) {
    throw new RangeError("Hold minutes must be positive and finite, with a valid expiry");
  }
  const hold: Hold = {
    reason: opts.reason,
    pid: process.pid,
    until: expiry.toISOString(),
  };
  const path = holdPath(pidFilePath);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(hold, null, 2), { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
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
