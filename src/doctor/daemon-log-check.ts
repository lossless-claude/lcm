// src/doctor/daemon-log-check.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logEnding, readDaemonLog, type LogRecord, type LogState } from "../daemon/log.js";
import type { CheckResult } from "./types.js";
import { createLcmPaths } from "../lcm-paths.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

const endedUnclean = (r: LogRecord) => r.event === "daemon.start" && r.prev === "unclean";
const droppedRecords = (r: LogRecord) => r.event === "log.gap" || (r.event === "daemon.stop" && Number(r.dropped) > 0);

/**
 * What `/health` says about the log: its state, "unsupported" for a daemon that predates
 * the log, or undefined when no daemon answers.
 */
export type LiveLog = LogState | "unsupported" | undefined;

/**
 * Why the last 24 h of the log cannot prove it holds every record, or empty when it can.
 * With no daemon answering, a log whose last record (at any age) is not `daemon.stop`
 * belongs to a daemon that died and has not been restarted.
 */
function coverageGaps(records: LogRecord[], live: LogState | undefined, path: string): string[] {
  const checks: Array<[boolean, string]> = [
    [!live && logEnding(path) === "unclean", "the last daemon is not running and left no stop record"],
    [records.some(endedUnclean), "a daemon ended without a stop record"],
    [records.some(droppedRecords), "records were dropped"],
    [live?.failing === true, "the running daemon cannot write its log"],
  ];
  return checks.filter(([applies]) => applies).map(([, gap]) => gap);
}

/**
 * Daemon errors over the last 24 h. "0 errors" is reported only when the log
 * can prove continuity: no unclean predecessor, no gap, no live write failure.
 */
export function checkDaemonLog(lcmHome: string, reported: LiveLog, now = new Date()): CheckResult {
  const path = join(createLcmPaths(lcmHome).logsDir, "daemon.log");
  const base = { name: "daemon-log", category: "Daemon" } as const;
  if (reported === "unsupported") {
    return { ...base, status: "warn", message: "the running daemon predates the daemon log and records nothing\n     Fix: lcm daemon restart" };
  }
  const live = reported;
  if (!existsSync(path) && !live?.failing) {
    return { ...base, status: "warn", message: "no daemon log yet — it starts with the next daemon start\n     Fix: lcm daemon restart" };
  }
  const records = readDaemonLog(path, { since: new Date(now.getTime() - WINDOW_MS) });
  const errors = records.filter((r) => r.level === "error");
  const last = errors[errors.length - 1];
  const errorText = `${errors.length} daemon error${errors.length === 1 ? "" : "s"} (24h)${last ? ` — last: ${last.event}` : ""}`;
  const gaps = coverageGaps(records, live, path);
  if (gaps.length > 0) {
    return { ...base, status: "warn", message: `coverage incomplete: ${gaps.join("; ")}. ${errorText}\n     See: ${path}` };
  }
  return errors.length > 0
    ? { ...base, status: "warn", message: `${errorText}\n     See: ${path}` }
    : { ...base, status: "pass", message: errorText };
}
