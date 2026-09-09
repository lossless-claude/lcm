import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR, ensureProjectDir, projectId, projectMetaPath } from "./project.js";
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

export const groupIndexPath = (): string => join(BASE_DIR, "group-index.sqlite");

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
export function resolveSourceCwd(requestCwd: string, id: unknown): string | null {
  if (typeof id !== "string" || id === "" || id === projectId(requestCwd)) return requestCwd;
  return projectGroup(requestCwd).find(member => member.projectId === id)?.cwd ?? null;
}

function openIndex(): DatabaseSync {
  mkdirSync(BASE_DIR, { recursive: true });
  const db = new DatabaseSync(groupIndexPath());
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

function readGitMeta(cwd: string): ProjectGitMeta | null {
  const path = projectMetaPath(cwd);
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

function writeGitMeta(cwd: string, git: ProjectGitMeta): void {
  const path = projectMetaPath(cwd);
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

function indexIdentity(cwd: string, git: ProjectGitMeta): void {
  // A project with no remote can group with nothing; keep it out of the index.
  if (git.remotes.length === 0) return;
  const id = projectId(cwd);
  const db = openIndex();
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
export function recordProjectIdentity(cwd: string): ProjectGitMeta {
  const previous = readGitMeta(cwd);
  if (previous && isFresh(previous.checkedAt)) {
    // The index is derived state and `meta.json` is the record. Re-assert the
    // row even when discovery is skipped, so an index that was deleted, moved
    // or never built fills back in instead of staying empty until every
    // project's day is up.
    try { indexIdentity(cwd, previous); } catch { /* non-fatal, as below */ }
    return previous;
  }

  let git: ProjectGitMeta;
  try {
    git = mergeIdentity(previous, discoverGitIdentity(cwd));
  } catch {
    git = mergeIdentity(previous, null);
  }
  try {
    writeGitMeta(cwd, git);
    indexIdentity(cwd, git);
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

export async function backfillProjectIdentities(): Promise<number> {
  const projectsDir = join(BASE_DIR, "projects");
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
      recordProjectIdentity(cwd);
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
export function openProject(cwd: string): string {
  const dir = ensureProjectDir(cwd);
  recordProjectIdentity(cwd);
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
export function projectGroup(cwd: string): GroupMember[] {
  const self: GroupMember = { projectId: projectId(cwd), cwd };
  const git = readGitMeta(cwd);
  if (!git || git.remotes.length === 0) return [self];

  let rows: GroupMember[] = [];
  try {
    const db = openIndex();
    try {
      const placeholders = git.remotes.map(() => "?").join(", ");
      rows = db.prepare(
        `SELECT DISTINCT i.project_id AS projectId, i.cwd AS cwd
           FROM project_identity i
           JOIN project_remote r ON r.project_id = i.project_id
          WHERE r.remote IN (${placeholders})
            AND i.rel_path = ?
          ORDER BY i.cwd`,
      ).all(...git.remotes, git.relPath) as unknown as GroupMember[];
    } finally {
      db.close();
    }
  } catch {
    return [self];
  }

  const members = [self];
  for (const row of rows) {
    if (row.projectId === self.projectId) continue;
    if (!existsSync(row.cwd)) continue;
    members.push(row);
  }
  return members;
}
