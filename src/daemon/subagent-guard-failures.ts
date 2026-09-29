import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import { projectDbPath, projectDir } from "./project.js";
import { PKG_VERSION } from "./version.js";

type Failure = { fingerprint: string; db: string; sessionId: string; parentSessionId: string; message: string };
const failed = new Map<string, Failure>();
const projectRecords = new Map<string, { db: string | undefined; failures: Record<string, Failure> }>();

function dbIdentity(cwd: string, paths: LcmPaths): string | undefined {
  try {
    const st = statSync(projectDbPath(cwd, paths));
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/** Only the child's transcript and sidecar affect whether its failed capture can change. */
export function subagentGuardFingerprint(path: string): string | undefined {
  try {
    const transcript = statSync(path);
    let sidecar: { size: number; mtimeMs: number } | null = null;
    try {
      const st = statSync(path.replace(/\.jsonl$/, ".meta.json"));
      sidecar = { size: st.size, mtimeMs: st.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    return JSON.stringify([transcript.size, transcript.mtimeMs, sidecar]);
  } catch {
    return undefined;
  }
}

function sidecarPath(cwd: string, paths: LcmPaths): string {
  return join(projectDir(cwd, paths), "subagent-guard-failures.json");
}

function readRecords(cwd: string, paths: LcmPaths): Record<string, Failure> {
  try {
    const parsed = JSON.parse(readFileSync(sidecarPath(cwd, paths), "utf8")) as {
      db?: unknown; version?: unknown; failures?: Record<string, Failure>;
    };
    const db = dbIdentity(cwd, paths);
    if (db === undefined || parsed.db !== db || parsed.version !== (PKG_VERSION ?? null)) return {};
    if (!parsed.failures || typeof parsed.failures !== "object") return {};
    return parsed.failures;
  } catch {
    return {};
  }
}

function records(cwd: string, paths: LcmPaths): Record<string, Failure> {
  const key = sidecarPath(cwd, paths);
  const db = dbIdentity(cwd, paths);
  let current = projectRecords.get(key);
  if (!current || current.db !== db) {
    current = { db, failures: readRecords(cwd, paths) };
    projectRecords.set(key, current);
  }
  return current.failures;
}

function writeRecords(cwd: string, paths: LcmPaths, current: Record<string, Failure>): void {
  const db = dbIdentity(cwd, paths);
  if (!db) return;
  const path = sidecarPath(cwd, paths);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ db, version: PKG_VERSION ?? null, failures: current }));
    renameSync(tmp, path);
  } catch { /* capture remains best effort when diagnostic storage is unavailable */ }
}

export function skipUnchangedSubagentGuard(cwd: string, paths: LcmPaths, path: string, fingerprint: string | undefined): boolean {
  const prior = failed.get(path);
  return fingerprint !== undefined && prior?.fingerprint === fingerprint && prior.db === dbIdentity(cwd, paths);
}

export function rememberSubagentGuard(
  cwd: string, paths: LcmPaths, path: string, fingerprint: string | undefined,
  sessionId: string, parentSessionId: string, message: string,
): void {
  const db = dbIdentity(cwd, paths);
  if (fingerprint === undefined || db === undefined) return;
  const failure = { fingerprint, db, sessionId, parentSessionId, message };
  failed.set(path, failure);
  const current = records(cwd, paths);
  current[path] = failure;
  writeRecords(cwd, paths, current);
}

export function forgetSubagentGuard(cwd: string, paths: LcmPaths, path: string): void {
  failed.delete(path);
  const current = records(cwd, paths);
  if (!(path in current)) return;
  delete current[path];
  writeRecords(cwd, paths, current);
}

/** Doctor reads the sidecar in its own process and verifies that each file still matches. */
export function stalledSubagentGuards(cwd: string, paths: LcmPaths): Array<{ path: string; failure: Failure }> {
  return Object.entries(readRecords(cwd, paths))
    .filter(([path, failure]) => failure && typeof failure.fingerprint === "string" &&
      failure.db === dbIdentity(cwd, paths) && subagentGuardFingerprint(path) === failure.fingerprint)
    .map(([path, failure]) => ({ path, failure }));
}
