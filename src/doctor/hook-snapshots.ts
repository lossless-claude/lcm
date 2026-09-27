import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectId } from "../daemon/project.js";

export interface LocalHookSnapshot {
  sessionId: string;
  cwd: string;
  updatedAt: number;
  truncated: boolean;
  observations: Array<{
    hook: string;
    operation: string;
    kind: "delivery" | "execution";
    status: string;
    reason: string;
    count: number;
  }>;
  failures: Array<{ hook: string; operation: string; code: string; at: number }>;
}

const FUNCTION_SNAPSHOT_NAME = /^lcm-hook-observe-[a-zA-Z0-9_%-]+-[01]\.json$/;
const OMP_SNAPSHOT_NAME = /^lcm-hook-observe-omp-[a-zA-Z0-9_%-]+-[01]\.json$/;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIELD = /^[a-zA-Z0-9_.:-]*$/;

/** Read the latest valid slot per Session without changing the host's files. */
function readSnapshots(
  cwd: string, dir: string, now: number, harness: "claude-function" | "omp",
): LocalHookSnapshot[] {
  const expectedProject = projectId(cwd);
  let names: string[];
  try {
    const pattern = harness === "omp" ? OMP_SNAPSHOT_NAME : FUNCTION_SNAPSHOT_NAME;
    names = readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return [];
  }
  const candidates = names.flatMap((name) => {
    try {
      const stat = lstatSync(join(dir, name));
      if (!stat.isFile()) return [];
      return [{ name, stat }];
    } catch { return []; }
  }).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 500);
  const latest = new Map<string, LocalHookSnapshot & { seq: number; generation: number }>();
  for (const { name, stat } of candidates) {
    try {
      const path = join(dir, name);
      if (stat.size > MAX_SNAPSHOT_BYTES || now - stat.mtimeMs > MAX_SNAPSHOT_AGE_MS) continue;
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (value.version !== 1 || value.harness !== harness
        || typeof value.cwd !== "string" || projectId(value.cwd) !== expectedProject
        || typeof value.sessionId !== "string" || typeof value.seq !== "number"
        || !Number.isSafeInteger(value.seq) || value.seq < 0 || !Array.isArray(value.observations)) continue;
      const observations: LocalHookSnapshot["observations"] = [];
      for (const item of value.observations) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (typeof row.hook !== "string" || typeof row.operation !== "string"
          || (row.kind !== "delivery" && row.kind !== "execution")
          || typeof row.status !== "string" || typeof row.reason !== "string"
          || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 1
          || [row.hook, row.operation, row.status, row.reason].some((field) => field.length > 80 || !FIELD.test(field))) continue;
        observations.push(row as LocalHookSnapshot["observations"][number]);
        if (observations.length >= 128) break;
      }
      const failures: LocalHookSnapshot["failures"] = [];
      for (const item of Array.isArray(value.failures) ? value.failures : []) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (typeof row.hook !== "string" || typeof row.operation !== "string"
          || typeof row.code !== "string" || typeof row.at !== "number"
          || !Number.isFinite(row.at) || row.at < 0 || row.at > 8.64e15
          || [row.hook, row.operation, row.code].some((field) => field.length > 80 || !FIELD.test(field))) continue;
        failures.push(row as LocalHookSnapshot["failures"][number]);
        if (failures.length >= 32) break;
      }
      const snapshot = {
        sessionId: value.sessionId, cwd, seq: value.seq,
        generation: typeof value.generation === "number" && Number.isFinite(value.generation) ? value.generation : 0,
        updatedAt: stat.mtimeMs,
        truncated: value.truncated === true || observations.length < value.observations.length
          || (Array.isArray(value.failures) && failures.length < value.failures.length),
        observations, failures,
      };
      const previous = latest.get(snapshot.sessionId);
      if (!previous || snapshot.updatedAt > previous.updatedAt
        || (snapshot.updatedAt === previous.updatedAt && (snapshot.generation > previous.generation
          || (snapshot.generation === previous.generation && snapshot.seq > previous.seq)))) {
        latest.set(snapshot.sessionId, snapshot);
      }
    } catch { /* A partial slot leaves the other slot available. */ }
  }
  return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
}

export function readFunctionHookSnapshots(cwd: string, dir = tmpdir(), now = Date.now()): LocalHookSnapshot[] {
  return readSnapshots(cwd, dir, now, "claude-function");
}

export function readOmpHookSnapshots(cwd: string, logsDir: string, now = Date.now()): LocalHookSnapshot[] {
  return readSnapshots(cwd, logsDir, now, "omp");
}
