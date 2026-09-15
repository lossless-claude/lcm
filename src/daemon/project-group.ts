import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectDir, projectId, projectMetaPath } from "./project.js";
import type { LcmPaths } from "../lcm-paths.js";
import { discoverGitIdentity, type GitIdentity } from "./git-identity.js";

/**
 * Projects are stored by cwd — one directory, one database. That key is right
 * for storage and wrong for recall: the same repository checked out twice, or a
 * worktree beside its main checkout, becomes several unrelated memories.
 *
 * This module records the second dimension. A project's git remotes and its
 * path inside the repository go into its `meta.json` and into one global index,
 * so recall can union the databases that describe the same place in the same
 * repository. Nothing is ever merged physically, and a project whose folder has
 * vanished simply stops matching at read time.
 */

/** Remotes recorded so far are re-checked no more often than this. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const groupIndexPath = (paths: LcmPaths): string => join(paths.home, "group-index.sqlite");

interface ProjectGitMeta {
  remotes: string[];
  relPath: string;
  checkedAt: string;
}

/** One project in a group, as the index knows it. */
export interface GroupMember {
  projectId: string;
  cwd: string;
}

interface IndexedGroupMember extends GroupMember {
  relPath: string;
  remote: string;
}

type ReadGroupIndex = (paths: LcmPaths) => IndexedGroupMember[];
export type ReadGroupMembers = (paths: LcmPaths, relPath: string, remotes: readonly string[]) => IndexedGroupMember[];

/** How a project is named on a result that leaves the daemon. */
export const projectRef = (cwd: string) => ({ id: projectId(cwd), cwd });

/**
 * The cwd whose database an id from a search result should be read against:
 * the request's own project when no project is named, otherwise the group
 * member that owns it. Null when the id names no member of the group.
 *
 * Callers must go through here rather than trusting the id. `conversation_id`
 * and `message_id` are `AUTOINCREMENT` per database, so an id resolved against
 * the wrong project silently returns a different message.
 */
export function resolveSourceCwd(requestCwd: string, id: unknown, paths: LcmPaths): string | null {
  if (typeof id !== "string" || id === "" || id === projectId(requestCwd)) return requestCwd;
  return projectGroup(requestCwd, paths).find(member => member.projectId === id)?.cwd ?? null;
}

function openIndex(paths: LcmPaths): DatabaseSync {
  mkdirSync(paths.home, { recursive: true });
  const db = new DatabaseSync(groupIndexPath(paths));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_identity (
      project_id TEXT PRIMARY KEY,
      cwd        TEXT NOT NULL,
      rel_path   TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_remote (
      project_id TEXT NOT NULL,
      remote     TEXT NOT NULL,
      PRIMARY KEY (project_id, remote)
    );
    CREATE INDEX IF NOT EXISTS project_remote_by_remote ON project_remote(remote);
  `);
  return db;
}

function readGitMeta(cwd: string, paths: LcmPaths): ProjectGitMeta | null {
  const path = projectMetaPath(cwd, paths);
  if (!existsSync(path)) return null;
  try {
    const git = JSON.parse(readFileSync(path, "utf-8")).git;
    if (!git || !Array.isArray(git.remotes)) return null;
    return {
      remotes: git.remotes.filter((r: unknown): r is string => typeof r === "string"),
      relPath: typeof git.relPath === "string" ? git.relPath : "",
      checkedAt: typeof git.checkedAt === "string" ? git.checkedAt : "",
    };
  } catch {
    return null;
  }
}

function writeGitMeta(cwd: string, git: ProjectGitMeta, paths: LcmPaths): void {
  const path = projectMetaPath(cwd, paths);
  let meta: Record<string, unknown> = { cwd };
  if (existsSync(path)) {
    try { meta = JSON.parse(readFileSync(path, "utf-8")); } catch { /* keep default */ }
  }
  writeFileSync(path, JSON.stringify({ ...meta, git }, null, 2));
}

function isFresh(checkedAt: string): boolean {
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) && Date.now() - at < REFRESH_INTERVAL_MS;
}

/**
 * Merges a freshly discovered identity into what was recorded before. Remotes
 * only ever accumulate: a repository that moved host or changed protocol keeps
 * grouping with the sessions recorded under its old address.
 */
function mergeIdentity(previous: ProjectGitMeta | null, found: GitIdentity | null): ProjectGitMeta {
  const remotes = new Set(previous?.remotes ?? []);
  for (const remote of found?.remotes ?? []) remotes.add(remote);
  return {
    remotes: [...remotes].sort(),
    relPath: found?.relPath ?? previous?.relPath ?? "",
    checkedAt: new Date().toISOString(),
  };
}

function indexIdentity(cwd: string, git: ProjectGitMeta, paths: LcmPaths): void {
  // A project with no remote can group with nothing; keep it out of the index.
  if (git.remotes.length === 0) return;
  const id = projectId(cwd);
  const db = openIndex(paths);
  try {
    db.prepare(
      `INSERT INTO project_identity (project_id, cwd, rel_path, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET cwd = excluded.cwd,
                                             rel_path = excluded.rel_path,
                                             updated_at = excluded.updated_at`,
    ).run(id, cwd, git.relPath, git.checkedAt);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO project_remote (project_id, remote) VALUES (?, ?)",
    );
    for (const remote of git.remotes) insert.run(id, remote);
  } finally {
    db.close();
  }
}

/**
 * Records `cwd`'s git identity in its `meta.json` and in the global index,
 * re-running git at most once a day per project. Returns what is now recorded.
 *
 * Never throws: a project outside a repository, or a machine without git, keeps
 * working with an empty remote set and simply groups with nothing.
 */
export function recordProjectIdentity(cwd: string, paths: LcmPaths): ProjectGitMeta {
  const previous = readGitMeta(cwd, paths);
  if (previous && isFresh(previous.checkedAt)) {
    // The index is derived state and `meta.json` is the record. Re-assert the
    // row even when discovery is skipped, so an index that was deleted, moved
    // or never built fills back in instead of staying empty until every
    // project's day is up.
    try { indexIdentity(cwd, previous, paths); } catch { /* non-fatal, as below */ }
    return previous;
  }

  let git: ProjectGitMeta;
  try {
    git = mergeIdentity(previous, discoverGitIdentity(cwd));
  } catch {
    git = mergeIdentity(previous, null);
  }
  try {
    writeGitMeta(cwd, git, paths);
    indexIdentity(cwd, git, paths);
  } catch {
    // Identity is an optimisation for recall; failing to record it must never
    // fail the ingest or compaction that happened to trigger it.
  }
  return git;
}

/**
 * Records the identity of every project already on disk, so a checkout that is
 * never written to again still joins its group. The daily refresh interval
 * makes every run after the first one nearly free.
 *
 * Yields to the event loop as it goes: a store of ~9000 projects takes seconds
 * to walk, and the daemon must keep answering while it does.
 *
 * Returns how many projects were visited.
 */
const BACKFILL_YIELD_EVERY = 50;

export async function backfillProjectIdentities(paths: LcmPaths): Promise<number> {
  const projectsDir = paths.projectsDir;
  if (!existsSync(projectsDir)) return 0;

  let seen = 0;
  let visited = 0;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (++seen % BACKFILL_YIELD_EVERY === 0) await new Promise(setImmediate);
    const metaPath = join(projectsDir, entry.name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const cwd = JSON.parse(readFileSync(metaPath, "utf-8")).cwd;
      // A project whose folder is gone cannot be asked for its remotes; leave
      // whatever was recorded before untouched.
      if (typeof cwd !== "string" || !existsSync(cwd)) continue;
      recordProjectIdentity(cwd, paths);
      visited += 1;
    } catch {
      // A corrupt meta.json skips that project, never the whole backfill.
    }
  }
  return visited;
}

/**
 * Ensures the project directory exists and its git identity is up to date.
 * Every route that writes to a project goes through here, so the index tracks
 * whatever the daemon has actually seen.
 */
export function openProject(cwd: string, paths: LcmPaths): string {
  const dir = ensureProjectDir(cwd, paths);
  recordProjectIdentity(cwd, paths);
  return dir;
}

/**
 * The projects that describe the same place in the same repository as `cwd`:
 * any project sharing at least one remote and sitting at the same path relative
 * to the repository root. `cwd` itself is always the first member.
 *
 * A member whose directory no longer exists is dropped here rather than deleted
 * from the index, so a temporarily unmounted checkout comes back on its own.
 */
function readGroupIndex(paths: LcmPaths): IndexedGroupMember[] {
  try {
    const db = openIndex(paths);
    try {
      return db.prepare(
        `SELECT i.project_id AS projectId, i.cwd AS cwd, i.rel_path AS relPath, r.remote AS remote
           FROM project_identity i
           JOIN project_remote r ON r.project_id = i.project_id
          ORDER BY i.cwd`,
      ).all() as unknown as IndexedGroupMember[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Reads only the index rows that can belong to one project's group. */
function readGroupMembers(paths: LcmPaths, relPath: string, remotes: readonly string[]): IndexedGroupMember[] {
  if (remotes.length === 0) return [];
  try {
    const db = openIndex(paths);
    try {
      const placeholders = remotes.map(() => "?").join(", ");
      return db.prepare(
        `SELECT i.project_id AS projectId, i.cwd AS cwd, i.rel_path AS relPath, r.remote AS remote
           FROM project_identity i
           JOIN project_remote r ON r.project_id = i.project_id
          WHERE i.rel_path = ? AND r.remote IN (${placeholders})
          ORDER BY i.cwd`,
      ).all(relPath, ...remotes) as unknown as IndexedGroupMember[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function groupFromRows(cwd: string, git: ProjectGitMeta | null, rows: Iterable<IndexedGroupMember>): GroupMember[] {
  const self: GroupMember = { projectId: projectId(cwd), cwd };
  if (!git || git.remotes.length === 0) return [self];

  const remotes = new Set(git.remotes);
  const seen = new Set([self.projectId]);
  const siblings: GroupMember[] = [];
  for (const row of rows) {
    if (row.relPath !== git.relPath || !remotes.has(row.remote) || seen.has(row.projectId) || !existsSync(row.cwd)) continue;
    seen.add(row.projectId);
    siblings.push({ projectId: row.projectId, cwd: row.cwd });
  }
  return [self, ...siblings.sort((a, b) => a.cwd.localeCompare(b.cwd))];
}

/**
 * Resolves several project groups from one read of the identity index. Each requested
 * project retains projectGroup's asymmetric result: itself is first, and vanished siblings
 * are omitted without removing their index records.
 */
export function projectGroups(cwds: Iterable<string>, paths: LcmPaths, readIndex: ReadGroupIndex = readGroupIndex): Map<string, GroupMember[]> {
  const requested = [...new Set(cwds)];
  const metas = new Map(requested.map(cwd => [cwd, readGitMeta(cwd, paths)]));
  const rowsByIdentity = new Map<string, IndexedGroupMember[]>();
  const hasGroupableProject = [...metas.values()].some(git => git && git.remotes.length > 0);
  for (const row of hasGroupableProject ? readIndex(paths) : []) {
    const key = `${row.relPath}\0${row.remote}`;
    const members = rowsByIdentity.get(key) ?? [];
    members.push(row);
    rowsByIdentity.set(key, members);
  }

  const groups = new Map<string, GroupMember[]>();
  for (const cwd of requested) {
    const git = metas.get(cwd);
    const rows = git ? git.remotes.flatMap(remote => rowsByIdentity.get(`${git.relPath}\0${remote}`) ?? []) : [];
    groups.set(cwd, groupFromRows(cwd, git ?? null, rows));
  }
  return groups;
}

export function projectGroup(cwd: string, paths: LcmPaths, readMembers: ReadGroupMembers = readGroupMembers): GroupMember[] {
  const git = readGitMeta(cwd, paths);
  return groupFromRows(cwd, git, git ? readMembers(paths, git.relPath, git.remotes) : []);
}
