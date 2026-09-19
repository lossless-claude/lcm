import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import { projectMetaPath } from "./project.js";

/**
 * The one owner of a project's `meta.json`. Every read parses it here and every
 * write goes through one read-modify-write, so which code path meets the file
 * first never changes what it holds afterwards.
 *
 * Corrupt-file policy: a read treats an unparsable file as absent. An update
 * moves the unparsable file aside as `meta.json.corrupt-<timestamp>` and starts
 * again from the caller's keys, so the project heals on its next write and the
 * bad bytes stay on disk for inspection. Writes land through a temporary file
 * and a rename, so a crash mid-write cannot leave a torn `meta.json`.
 *
 * The read-modify-write is synchronous end to end, so within one process no
 * other update can interleave with it.
 */
export interface ProjectMeta {
  cwd?: string;
  git?: unknown;
  language?: string;
  languageDetectedAt?: string;
  lastIngest?: string;
  lastCompact?: string;
  lastPromote?: string;
  [key: string]: unknown;
}

const metaPathIn = (projectDir: string): string => join(projectDir, "meta.json");

function readMetaFile(metaPath: string): ProjectMeta | null {
  let content: string;
  try {
    content = readFileSync(metaPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ProjectMeta;
  } catch {
    return null;
  }
}

function updateMetaFile(metaPath: string, patch: ProjectMeta): ProjectMeta {
  mkdirSync(dirname(metaPath), { recursive: true });
  let current = readMetaFile(metaPath);
  if (current === null && existsSync(metaPath)) {
    renameSync(metaPath, `${metaPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  current ??= {};
  const next: ProjectMeta = { ...current, ...patch };
  const tmpPath = `${metaPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmpPath, metaPath);
  return next;
}

/** The record for `cwd`, or null when it is absent or unparsable. */
export const readProjectMeta = (cwd: string, paths: LcmPaths): ProjectMeta | null =>
  readMetaFile(projectMetaPath(cwd, paths));

/** The record in a project directory (for callers enumerating `projects/*`). */
export const readProjectMetaIn = (projectDir: string): ProjectMeta | null =>
  readMetaFile(metaPathIn(projectDir));

/** Merges `patch` into `cwd`'s record; `cwd` itself is always re-asserted. */
export const updateProjectMeta = (cwd: string, paths: LcmPaths, patch: ProjectMeta): ProjectMeta =>
  updateMetaFile(projectMetaPath(cwd, paths), { ...patch, cwd });

/** Merges `patch` into the record in a project directory. */
export const updateProjectMetaIn = (projectDir: string, patch: ProjectMeta): ProjectMeta =>
  updateMetaFile(metaPathIn(projectDir), patch);
