import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectId } from "../daemon/project.js";

export interface LoggedHookOutcome {
  sessionId: string;
  harness: string;
  hook: string;
  operation: string;
  kind: string;
  status: string;
  reason: string;
  count: number;
  lastSeen: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 + 4096;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIELD = /^[a-zA-Z0-9_.:-]*$/;

/** Aggregate a bounded local hook log; missing or invalid records never imply a hook did not run. */
export function readHookOutcomeLog(
  logsDir: string, cwd: string, now = Date.now(),
): { outcomes: LoggedHookOutcome[]; failures: LoggedHookOutcome[]; truncated: boolean } {
  const counts = new Map<string, LoggedHookOutcome>();
  const expectedProject = projectId(cwd);
  const seen = new Set<string>();
  const failures: LoggedHookOutcome[] = [];
  let truncated = false;
  for (const name of ["hook-outcomes.log.1", "hook-outcomes.log"]) {
    const path = join(logsDir, name);
    let content: string;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { truncated = true; continue; }
      content = readFileSync(path, "utf8");
    } catch { continue; }
    if (name.endsWith(".1")) truncated = true;
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.projectId !== expectedProject) continue;
        if (typeof row.ts !== "number" || !Number.isFinite(row.ts)
          || typeof row.sessionId !== "string"
          || !row.sessionId || row.sessionId.length > 160
          || typeof row.harness !== "string" || typeof row.hook !== "string"
          || typeof row.operation !== "string" || typeof row.kind !== "string"
          || typeof row.status !== "string" || typeof row.reason !== "string"
          || [row.harness, row.hook, row.operation, row.kind, row.status, row.reason]
            .some((field) => field.length > 80 || !FIELD.test(field))) { truncated = true; continue; }
        if (now - row.ts > MAX_AGE_MS) continue;
        if (typeof row.operationId === "string") {
          const identity = JSON.stringify([row.sessionId, row.harness, row.hook,
            row.operation, row.kind, row.operationId]);
          if (seen.has(identity)) continue;
          seen.add(identity);
        }
        const key = JSON.stringify([row.sessionId, row.harness, row.hook, row.operation,
          row.kind, row.status, row.reason]);
        const prior = counts.get(key);
        if (prior) {
          prior.count++;
          prior.lastSeen = Math.max(prior.lastSeen, row.ts);
        } else counts.set(key, {
          sessionId: row.sessionId, harness: row.harness, hook: row.hook,
          operation: row.operation, kind: row.kind, status: row.status,
          reason: row.reason, count: 1, lastSeen: row.ts,
        });
        if (row.status === "failed" || row.status === "rejected") {
          const code = typeof row.failureCode === "string" && row.failureCode.length <= 80
            && FIELD.test(row.failureCode) ? row.failureCode : row.reason;
          failures.push({ sessionId: row.sessionId, harness: row.harness, hook: row.hook,
            operation: row.operation, kind: row.kind, status: row.status,
            reason: code, count: 1, lastSeen: row.ts });
        }
      } catch { truncated = true; }
    }
  }
  return {
    outcomes: [...counts.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 20),
    failures: failures.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 10),
    truncated,
  };
}
