import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import { projectDbPath, projectDir } from "./project.js";
import { CODEX_RECOVERY_RULE_VERSION } from "../transcript-source.js";
import { PKG_VERSION } from "./version.js";

type Failure = {
  fingerprint: string; db: string; sessionId: string; parentSessionId?: string; message: string;
  client?: "codex"; terminal?: boolean; recoveryRuleVersion?: number;
};
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
    if (db === undefined || parsed.db !== db) return {};
    if (!parsed.failures || typeof parsed.failures !== "object") return {};
    return parsed.version === (PKG_VERSION ?? null) ? parsed.failures :
      Object.fromEntries(Object.entries(parsed.failures).filter(([, failure]) => failure?.terminal === true));
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

/** Whether the sidecar now holds `current`; capture stays best effort when diagnostic storage is unavailable. */
function writeRecords(cwd: string, paths: LcmPaths, current: Record<string, Failure>): boolean {
  const db = dbIdentity(cwd, paths);
  if (!db) return false;
  const path = sidecarPath(cwd, paths);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ db, version: PKG_VERSION ?? null, failures: current }));
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

export function skipUnchangedSubagentGuard(cwd: string, paths: LcmPaths, path: string, fingerprint: string | undefined): boolean {
  const prior = failed.get(path);
  return fingerprint !== undefined && prior?.fingerprint === fingerprint && prior.db === dbIdentity(cwd, paths);
}

/** Terminal Codex failures survive transcript growth, path changes and daemon restarts. */
export function terminalTranscriptGuard(cwd: string, paths: LcmPaths, sessionId: string): Failure | undefined {
  const failure = Object.values(records(cwd, paths)).find(failure => failure?.terminal === true && failure.client === "codex" &&
    failure.sessionId === sessionId && failure.db === dbIdentity(cwd, paths) && typeof failure.message === "string");
  if (failure && failure.recoveryRuleVersion !== CODEX_RECOVERY_RULE_VERSION) {
    forgetSubagentGuardSession(cwd, paths, sessionId);
    return undefined;
  }
  return failure;
}

export function rememberSubagentGuard(
  cwd: string, paths: LcmPaths, path: string, fingerprint: string | undefined,
  sessionId: string, parentSessionId: string | undefined, message: string,
  options: { client?: "codex"; terminal?: boolean } = {},
): void {
  const db = dbIdentity(cwd, paths);
  if ((fingerprint === undefined && !options.terminal) || db === undefined) return;
  if (options.terminal && terminalTranscriptGuard(cwd, paths, sessionId)) return;
  const failure = { fingerprint: fingerprint ?? "", db, sessionId, parentSessionId, message, ...options,
    ...(options.terminal ? { recoveryRuleVersion: CODEX_RECOVERY_RULE_VERSION } : {}),
  };
  const current = records(cwd, paths);
  current[path] = failure;
  // Skip only what doctor can list: an unrecorded failure stays retried every pass.
  if (writeRecords(cwd, paths, current)) failed.set(path, failure);
  else delete current[path];
}

export function forgetSubagentGuard(cwd: string, paths: LcmPaths, path: string): void {
  failed.delete(path);
  const current = records(cwd, paths);
  if (!(path in current)) return;
  delete current[path];
  writeRecords(cwd, paths, current);
}

/** Drops every failure recorded for a session, whatever path discovery gave its transcript: a rebuild replaced its stored history. */
export function forgetSubagentGuardSession(cwd: string, paths: LcmPaths, sessionId: string): void {
  for (const [path, failure] of failed) if (failure.sessionId === sessionId) failed.delete(path);
  const current = records(cwd, paths);
  const stale = Object.keys(current).filter((path) => current[path]?.sessionId === sessionId);
  if (stale.length === 0) return;
  for (const path of stale) delete current[path];
  writeRecords(cwd, paths, current);
}

/** Explicitly retry terminal Codex guards without changing any stored history. */
export function clearTerminalTranscriptGuards(cwd: string, paths: LcmPaths, sessionId?: string): number {
  const current = records(cwd, paths);
  const stale = Object.keys(current).filter(path => current[path]?.terminal === true && current[path]?.client === "codex" &&
    (sessionId === undefined || current[path]?.sessionId === sessionId));
  if (stale.length === 0) return 0;
  const remaining = { ...current };
  for (const path of stale) delete remaining[path];
  if (!writeRecords(cwd, paths, remaining)) throw new Error("Could not clear terminal Codex guards");
  for (const path of stale) {
    delete current[path];
    failed.delete(path);
  }
  return stale.length;
}

/** Doctor verifies unchanged-file guards and lists terminal failures independently of file growth. */
export function stalledSubagentGuards(cwd: string, paths: LcmPaths): Array<{ path: string; failure: Failure }> {
  return Object.entries(readRecords(cwd, paths))
    .filter(([path, failure]) => failure && typeof failure.fingerprint === "string" &&
      failure.db === dbIdentity(cwd, paths) &&
      (failure.terminal === true || subagentGuardFingerprint(path) === failure.fingerprint))
    .map(([path, failure]) => ({ path, failure }));
}
