import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { HookObservation } from "./events-db.js";
import type { LcmPaths } from "../lcm-paths.js";
import { withHookWrite } from "./write-admission.js";
import { projectId } from "../daemon/project.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2048;
const FIELD = /^[a-zA-Z0-9_.:-]*$/;

/** Command hooks use a bounded local append log without loading SQLite at startup. */
export function observeHook(
  cwd: string | undefined,
  observation: HookObservation,
  paths: LcmPaths,
): boolean {
  try {
    if (typeof cwd !== "string" || !cwd || cwd.length > 32 * 1024
      || typeof observation.sessionId !== "string" || !observation.sessionId) return false;
    const fields = [observation.harness, observation.hook, observation.operation,
      observation.kind, observation.status, observation.reason ?? "", observation.failureCode ?? ""];
    if (fields.some((value) => value.length > 80 || !FIELD.test(value))
      || observation.sessionId.length > 160 || (observation.operationId?.length ?? 0) > 160) return false;
    const entry = JSON.stringify({ ts: Date.now(), projectId: projectId(cwd), ...observation,
      reason: observation.reason ?? "" }) + "\n";
    if (Buffer.byteLength(entry) > MAX_ENTRY_BYTES) return false;
    return withHookWrite(paths, () => {
      mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
      const path = join(paths.logsDir, "hook-outcomes.log");
      try {
        if (statSync(path).size >= MAX_LOG_BYTES) renameSync(path, `${path}.1`);
      } catch { /* No prior log, or another hook already rotated it. */ }
      appendFileSync(path, entry, { mode: 0o600 });
      return true;
    }, false);
  } catch {
    return false; // diagnostic failure never changes a harness result
  }
}
