// src/doctor/daemon-log-check.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDaemonLog, type LogRecord, type LogState } from "../daemon/log.js";
import type { CheckResult } from "./types.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Why the last 24 h of the log cannot prove it holds every record, or empty when it can. */
function coverageGaps(records: LogRecord[], live: LogState | undefined): string[] {
  const gaps: string[] = [];
  if (records.some((r) => r.event === "daemon.start" && r.prev === "unclean")) gaps.push("a daemon ended without a stop record");
  if (records.some((r) => r.event === "log.gap" || (r.event === "daemon.stop" && Number(r.dropped) > 0))) gaps.push("records were dropped");
  if (live?.failing) gaps.push("the running daemon cannot write its log");
  return gaps;
}

/**
 * Daemon errors over the last 24 h. "0 errors" is reported only when the log
 * can prove continuity: no unclean predecessor, no gap, no live write failure.
 */
export function checkDaemonLog(lcmHome: string, live: LogState | undefined, now = new Date()): CheckResult {
  const path = join(lcmHome, "logs", "daemon.log");
  const base = { name: "daemon-log", category: "Daemon" } as const;
  if (!existsSync(path) && !live?.failing) {
    return { ...base, status: "warn", message: "no daemon log yet — it starts with the next daemon start\n     Fix: lcm daemon restart" };
  }
  const records = readDaemonLog(path, { since: new Date(now.getTime() - WINDOW_MS) });
  const errors = records.filter((r) => r.level === "error");
  const last = errors[errors.length - 1];
  const errorText = `${errors.length} daemon error${errors.length === 1 ? "" : "s"} (24h)${last ? ` — last: ${last.event}` : ""}`;
  const gaps = coverageGaps(records, live);
  if (gaps.length > 0) {
    return { ...base, status: "warn", message: `coverage incomplete: ${gaps.join("; ")}. ${errorText}\n     See: ${path}` };
  }
  return errors.length > 0
    ? { ...base, status: "warn", message: `${errorText}\n     See: ${path}` }
    : { ...base, status: "pass", message: errorText };
}
