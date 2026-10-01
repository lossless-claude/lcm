import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readProjectMetaIn } from "../daemon/project-meta.js";
import { groupIndexPath } from "../daemon/project-group.js";
import { readHold } from "../daemon/hold.js";
import { openStandaloneLcmConnection } from "../db/connection.js";
import { SummaryStore } from "../store/summary-store.js";
import type { LcmPaths } from "../lcm-paths.js";
import type { CheckResult } from "./types.js";

type ProjectStore = { id: string; dir: string; cwd: string };

/** Doctor runs over every store, test leftovers included; its lines stay readable. */
const DOCTOR_LIST_LIMIT = 20;

function temporaryOrTestCwd(cwd: string): boolean {
  const path = resolve(cwd);
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].map(root => resolve(root));
  return roots.some(root => path.startsWith(root + sep))
    || path.split(sep).some(part => /^(?:e2e-test-|lossless-(?:ingest|compact|status)-)/.test(part));
}

function staleProjectStores(paths: LcmPaths): { stale: ProjectStore[]; unchecked: string[] } {
  const stale: ProjectStore[] = [];
  const unchecked: string[] = [];
  let entries;
  try { entries = readdirSync(paths.projectsDir, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") unchecked.push(paths.projectsDir);
    return { stale, unchecked };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(paths.projectsDir, entry.name);
    try {
      const cwd = readProjectMetaIn(dir)?.cwd;
      // The store id is authoritative: re-hashing a vanished cwd loses its realpath,
      // so an alias can no longer reproduce the id used when the store was created.
      if (typeof cwd !== "string" || !isAbsolute(cwd) || !/^[a-f0-9]{64}$/.test(entry.name)) {
        unchecked.push(dir);
        continue;
      }
      if (!temporaryOrTestCwd(cwd)) continue;
      try { statSync(cwd); } catch (error) {
        // Permission or I/O failures do not establish that a checkout vanished.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        stale.push({ id: entry.name, dir, cwd });
      }
    } catch { unchecked.push(dir); }
  }
  return { stale, unchecked };
}

/** Read-only: a missing ordinary checkout may be an unmounted disk and is retained. */
export function checkStaleProjectStores(paths: LcmPaths): CheckResult {
  const { stale, unchecked } = staleProjectStores(paths);
  // The full list belongs to the cleanup preview; doctor shows enough to recognise the pattern.
  const lines = stale.slice(0, DOCTOR_LIST_LIMIT).map(store => `     ${store.id}: ${store.cwd}`);
  if (stale.length > DOCTOR_LIST_LIMIT) lines.push(`     … and ${stale.length - DOCTOR_LIST_LIMIT} more`);
  for (const dir of unchecked) lines.push(`     ${dir}: not checked (unreadable or invalid project record)`);
  if (stale.length) lines.push("     Preview cleanup: lcm doctor --cleanup-stale-projects --dry-run");
  return {
    name: "stale-project-stores", category: "Storage",
    status: stale.length || unchecked.length ? "warn" : "pass",
    message: `${stale.length} stale project stores (missing temporary or test directories)` + (lines.length ? `\n${lines.join("\n")}` : ""),
  };
}

function requireOffline(paths: LcmPaths): void {
  if (!readHold(paths.pidPath)) throw new Error("Cleanup requires an offline hold: lcm daemon stop --hold");
  for (const dir of [paths.tmpDir, paths.home]) {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      const match = /^daemon\.starting\.(\d+)\./.exec(name);
      if (match && processAlive(Number(match[1]))) throw new Error("Cleanup refused: database activity is still running");
    }
  }
  let pid: number;
  try { pid = Number(readFileSync(paths.pidPath, "utf8").trim()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Cannot verify daemon state: invalid pid file");
  if (processAlive(pid)) throw new Error("Cleanup refused: daemon is still running");
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Cannot verify database activity: invalid pid");
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Defaults to a read-only preview. Apply preserves the complete store in lcm's trash. */
export function cleanupStaleProjectStores(paths: LcmPaths, apply = false): string {
  const { stale, unchecked } = staleProjectStores(paths);
  const lines = stale.map(store => `     ${store.id}: ${store.cwd}`);
  for (const dir of unchecked) lines.push(`     ${dir}: skipped (unreadable or invalid project record)`);
  if (!apply) {
    return `[dry-run] Would trash ${stale.length} project stores and their event sidecars\n${lines.join("\n")}\n` +
      "After review: lcm daemon stop --hold; lcm doctor --cleanup-stale-projects --apply; lcm daemon start";
  }
  requireOffline(paths);
  if (!stale.length) return `Trashed 0 project stores\n${lines.join("\n")}`;

  const batch = join(paths.home, "trash", "projects", `${Date.now()}-${randomUUID()}`);
  const moves: Array<{ from: string; to: string }> = [];
  const move = (from: string, to: string) => {
    renameSync(from, to);
    moves.push({ from, to });
  };
  const index = existsSync(groupIndexPath(paths)) ? new DatabaseSync(groupIndexPath(paths)) : undefined;
  let transaction = false;
  try {
    if (index) {
      index.exec("PRAGMA busy_timeout = 5000");
      index.exec("BEGIN IMMEDIATE");
      transaction = true;
    }
    mkdirSync(batch, { recursive: true });
    const events = new Map<string, string[]>();
    for (const name of existsSync(paths.eventsDir) ? readdirSync(paths.eventsDir) : []) {
      const id = /^([a-f0-9]{64})\.db(?:$|[-.])/.exec(name)?.[1];
      if (id) events.set(id, [...(events.get(id) ?? []), name]);
    }
    for (const store of stale) {
      requireOffline(paths);
      // Re-check eligibility immediately before moving, including its recorded cwd.
      if (readProjectMetaIn(store.dir)?.cwd !== store.cwd) throw new Error(`Project record changed: ${store.id}`);
      try { statSync(store.cwd); throw new Error(`Project directory returned: ${store.cwd}`); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      move(store.dir, join(batch, store.id));
      for (const name of events.get(store.id) ?? []) {
        mkdirSync(join(batch, "events"), { recursive: true });
        move(join(paths.eventsDir, name), join(batch, "events", name));
      }
      index?.prepare("DELETE FROM project_remote WHERE project_id = ?").run(store.id);
      index?.prepare("DELETE FROM project_identity WHERE project_id = ?").run(store.id);
    }
    if (index) { index.exec("COMMIT"); transaction = false; }
  } catch (error) {
    let rollbackFailed = false;
    if (transaction) {
      try { index!.exec("ROLLBACK"); } catch { rollbackFailed = true; }
    }
    const failed: string[] = [];
    for (const { from, to } of moves.reverse()) {
      try { renameSync(to, from); } catch { failed.push(to); }
    }
    if (failed.length) throw new Error(`Cleanup failed; preserved files needing manual restoration: ${failed.join(", ")}`, { cause: error });
    if (rollbackFailed) throw new Error("Cleanup failed; files restored but group-index rollback could not be confirmed", { cause: error });
    throw error;
  } finally { index?.close(); }
  return `Trashed ${stale.length} project store${stale.length === 1 ? "" : "s"}\n${lines.join("\n")}\nTrash directory: ${batch}`;
}

/** Read existing databases without migrations. Orphans are diagnostic evidence, not garbage. */
export function checkOrphanSummaries(paths: LcmPaths): CheckResult {
  const lines: string[] = [];
  let total = 0;
  let unchecked = 0;
  let projects: Dirent[];
  try { projects = readdirSync(paths.projectsDir, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      unchecked++;
      lines.push(`     ${paths.projectsDir}: not checked (unreadable)`);
    }
    projects = [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(paths.projectsDir, project.name);
    const path = join(dir, "db.sqlite");
    try {
      try { statSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const db = openStandaloneLcmConnection(path, { readOnly: true });
      try {
        const ids = new SummaryStore(db).getOrphanSummaryIds();
        total += ids.length;
        if (ids.length) {
          const shown = ids.slice(0, DOCTOR_LIST_LIMIT).join(", ") + (ids.length > DOCTOR_LIST_LIMIT ? ", …" : "");
          lines.push(`     ${dir}: ${ids.length} orphan summaries (${shown})`);
        }
      } finally { db.close(); }
    } catch {
      unchecked++;
      lines.push(`     ${dir}: not checked (unreadable database or unsupported schema)`);
    }
  }
  return {
    name: "orphan-summaries", category: "Storage", status: total || unchecked ? "warn" : "pass",
    message: `${total} orphan summaries (not in context or condensed by another summary)` +
      (lines.length ? `\n${lines.join("\n")}` : "") + (total ? "\n     Report only; no summaries or context were changed" : ""),
  };
}
