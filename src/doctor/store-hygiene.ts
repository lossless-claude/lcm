import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { projectMetaPathIn, readProjectMetaIn } from "../daemon/project-meta.js";
import { groupIndexPath } from "../daemon/project-group.js";
import { readHold } from "../daemon/hold.js";
import { openStandaloneLcmConnection } from "../db/connection.js";
import { SummaryStore } from "../store/summary-store.js";
import { PromotedStore } from "../db/promoted.js";
import type { LcmPaths } from "../lcm-paths.js";
import { doctorList, DOCTOR_LIST_LIMIT } from "./bounded-list.js";
import type { CheckResult } from "./types.js";

type ProjectStore = { id: string; dir: string; cwd: string };
type RecordlessStore = { id: string; dir: string; promoted: boolean | null };

function inspectRecordlessStore(id: string, dir: string): RecordlessStore {
  let promoted: boolean | null = null;
  try {
    const db = openStandaloneLcmConnection(join(dir, "db.sqlite"), { readOnly: true });
    try {
      promoted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'promoted'").get()
        && new PromotedStore(db).count() > 0;
    } finally { db.close(); }
  } catch { /* An unreadable database cannot establish whether it holds memories. */ }
  return { id, dir, promoted };
}

/** Row evidence is a recovery suggestion, never permission to relocate a store. */
function recoverableCwd(store: RecordlessStore, paths: LcmPaths): string | undefined {
  try {
    const db = openStandaloneLcmConnection(join(store.dir, "db.sqlite"), { readOnly: true });
    try {
      const candidates = new Set<string>();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      for (const table of tables) {
        const quotedTable = `"${table.name.replaceAll('"', '""')}"`;
        const columns = db.prepare(`PRAGMA table_info(${quotedTable})`).all() as { name: string }[];
        for (const field of ["cwd", "project_id"]) {
          if (!columns.some(column => column.name === field)) continue;
          const rows = db.prepare(`SELECT DISTINCT "${field}" AS value FROM ${quotedTable}`).all() as { value: unknown }[];
          for (const { value } of rows) {
            if (typeof value !== "string") continue;
            if (isAbsolute(value)) { candidates.add(value); continue; }
            if (field !== "project_id" || !/^[a-f0-9]{64}$/.test(value)) continue;
            const cwd = readProjectMetaIn(join(paths.projectsDir, value))?.cwd;
            if (typeof cwd === "string" && isAbsolute(cwd)) candidates.add(cwd);
          }
        }
      }
      return candidates.size === 1 ? [...candidates][0] : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

function temporaryOrTestCwd(cwd: string): boolean {
  const path = resolve(cwd);
  // Stored cwds are realpaths, so a symlinked temporary root (macOS /var/folders) counts in both forms.
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].flatMap(root => {
    const resolved = resolve(root);
    try { return [resolved, realpathSync(resolved)]; } catch { return [resolved]; }
  });
  return roots.some(root => path.startsWith(root + sep))
    || path.split(sep).some(part => /^(?:e2e-test-|lossless-(?:ingest|compact|status)-)/.test(part));
}

function staleProjectStores(paths: LcmPaths, cwdErrors?: Map<string, NodeJS.ErrnoException | null>): {
  stale: ProjectStore[]; unchecked: string[]; recordless: RecordlessStore[]; missingMeta: number; missingCwds: number;
} {
  const stale: ProjectStore[] = [];
  const unchecked: string[] = [];
  const recordless: RecordlessStore[] = [];
  let missingMeta = 0;
  let missingCwds = 0;
  let entries;
  try { entries = readdirSync(paths.projectsDir, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") unchecked.push(paths.projectsDir);
    return { stale, unchecked, recordless, missingMeta, missingCwds };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(paths.projectsDir, entry.name);
    try {
      const meta = readProjectMetaIn(dir);
      if (meta === null) {
        try { statSync(projectMetaPathIn(dir)); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missingMeta++;
          else throw error;
        }
      }
      const cwd = meta?.cwd;
      let cwdError: NodeJS.ErrnoException | undefined;
      if (typeof cwd === "string" && isAbsolute(cwd)) {
        try {
          if (cwdErrors) {
            const error = cwdErrors.get(dir);
            if (error !== null) throw error ?? new Error("cwd not checked");
          } else statSync(cwd);
        } catch (error) {
          cwdError = error as NodeJS.ErrnoException;
          if (cwdError.code === "ENOENT" || cwdError.code === "ENOTDIR") missingCwds++;
        }
      }
      // The store id is authoritative: re-hashing a vanished cwd loses its realpath,
      // so an alias can no longer reproduce the id used when the store was created.
      if (typeof cwd !== "string" || !isAbsolute(cwd) || !/^[a-f0-9]{64}$/.test(entry.name)) {
        unchecked.push(dir);
        if ((typeof cwd !== "string" || !isAbsolute(cwd)) && existsSync(join(dir, "db.sqlite"))) {
          recordless.push(inspectRecordlessStore(entry.name, dir));
        }
        continue;
      }
      if (cwdErrors && cwdError && cwdError.code !== "ENOENT" && cwdError.code !== "ENOTDIR") continue;
      if (!temporaryOrTestCwd(cwd)) continue;
      if (cwdError) {
        // Permission or I/O failures do not establish that a checkout vanished.
        if (cwdError.code !== "ENOENT") throw cwdError;
        stale.push({ id: entry.name, dir, cwd });
      }
    } catch { unchecked.push(dir); }
  }
  return { stale, unchecked, recordless, missingMeta, missingCwds };
}

export const CWD_CHECK_DEADLINE_MS = 100;
export const CWD_CHECK_CONCURRENCY = 4;
type CwdStat = (cwd: string) => Promise<unknown>;

async function checkCwds(paths: LcmPaths, statCwd: CwdStat): Promise<{
  cwdErrors: Map<string, NodeJS.ErrnoException | null>; uncheckedCwds: string[];
}> {
  const errors = new Map<string, NodeJS.ErrnoException | null>();
  const projects: Array<{ dir: string; cwd: string }> = [];
  let entries: Dirent[];
  try { entries = readdirSync(paths.projectsDir, { withFileTypes: true }); } catch {
    return { cwdErrors: errors, uncheckedCwds: [] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(paths.projectsDir, entry.name);
    const cwd = readProjectMetaIn(dir)?.cwd;
    if (typeof cwd === "string" && isAbsolute(cwd)) {
      projects.push({ dir, cwd });
      errors.set(dir, new Error("cwd not checked"));
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < projects.length) {
      const { dir, cwd } = projects[next++];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = Symbol("timeout");
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => statCwd(cwd)).then(() => null, error => error as NodeJS.ErrnoException),
          new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), CWD_CHECK_DEADLINE_MS); }),
        ]);
        // A timed-out stat cannot be cancelled. Keep its slot occupied instead of
        // launching an unbounded number of operations against an unreachable mount.
        if (result === timeout) return;
        errors.set(dir, result);
      } finally { clearTimeout(timer); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CWD_CHECK_CONCURRENCY, projects.length) }, worker));
  const uncheckedCwds = projects.filter(({ dir }) => {
    const error = errors.get(dir);
    return error && error.code !== "ENOENT" && error.code !== "ENOTDIR";
  }).map(({ cwd }) => cwd);
  return { cwdErrors: errors, uncheckedCwds };
}

/** Read-only: a missing ordinary checkout may be an unmounted disk and is retained. */
export async function checkStaleProjectStores(paths: LcmPaths, verbose = false, statCwd: CwdStat = stat): Promise<CheckResult> {
  const { cwdErrors, uncheckedCwds } = await checkCwds(paths, statCwd);
  const { stale, unchecked, recordless, missingMeta, missingCwds } = staleProjectStores(paths, cwdErrors);
  // The full list belongs to the cleanup preview; doctor shows enough to recognise the pattern.
  const lines = doctorList(stale, verbose, store => `     ${store.id}: ${store.cwd}`);
  lines.push(`     ${missingMeta} project directories without meta.json`);
  lines.push(`     ${missingCwds} project directories with missing cwd`);
  lines.push(`     ${uncheckedCwds.length} project directories with unchecked cwd`);
  lines.push(...doctorList(uncheckedCwds, verbose, cwd => `     ${cwd}: not checked (deadline exceeded or filesystem error)`));
  if (verbose) lines.push(...unchecked.map(dir => `     ${dir}: not checked (unreadable or invalid project record)`));
  if (unchecked.length) lines.push(`     ${unchecked.length} stores not checked (unreadable or invalid project record)`);
  if (recordless.length) {
    lines.push(`     ${recordless.length} record-less project stores; ${recordless.filter(store => store.promoted).length} hold promoted memories`);
    const unknown = recordless.filter(store => store.promoted === null).length;
    if (unknown) lines.push(`     Promoted memories not checked in ${unknown} unreadable databases`);
  }
  if (stale.length || unchecked.length) lines.push("     Preview cleanup: lcm doctor --cleanup-stale-projects --dry-run");
  return {
    name: "stale-project-stores", category: "Storage",
    status: stale.length || unchecked.length || uncheckedCwds.length ? "warn" : "pass",
    message: `${stale.length} stale project stores (missing temporary or test directories)` + (lines.length ? `\n${lines.join("\n")}` : ""),
  };
}

export function requireOffline(paths: LcmPaths): void {
  if (!readHold(paths.pidPath)) throw new Error("Requires an offline hold: lcm daemon stop --hold");
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
  const { stale, unchecked, recordless } = staleProjectStores(paths);
  const lines = stale.map(store => `     ${store.id}: ${store.cwd}`);
  for (const dir of unchecked) lines.push(`     ${dir}: skipped (unreadable or invalid project record)`);
  if (!apply) {
    for (const store of recordless) {
      const cwd = recoverableCwd(store, paths);
      if (cwd) lines.push(`     ${store.id}: recoverable cwd ${cwd}; review and restore the project record manually`);
    }
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
export function checkOrphanSummaries(paths: LcmPaths, verbose = false): CheckResult {
  const lines: string[] = [];
  let total = 0;
  let unchecked = 0;
  // A store line can shorten its own id list even when doctorList shows every line.
  let idsCut = false;
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
        if (!db.prepare("SELECT 1 FROM summaries LIMIT 1").get()) continue;
        const ids = new SummaryStore(db).getOrphanSummaryIds();
        total += ids.length;
        if (ids.length) {
          if (!verbose && ids.length > DOCTOR_LIST_LIMIT) idsCut = true;
          const shown = (verbose ? ids : ids.slice(0, DOCTOR_LIST_LIMIT)).join(", ") +
            (!verbose && ids.length > DOCTOR_LIST_LIMIT ? `, … and ${ids.length - DOCTOR_LIST_LIMIT} more` : "");
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
      (unchecked ? `\n     ${unchecked} stores not checked (unreadable database or unsupported schema)` : "") +
      (lines.length ? `\n${doctorList(lines, verbose, line => line).join("\n")}` : "") +
      (idsCut && lines.length <= DOCTOR_LIST_LIMIT ? "\n     Full details: lcm doctor --verbose" : "") + (total ? "\n     Report only; no summaries or context were changed" : ""),
  };
}
