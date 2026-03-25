import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, normalize, join as pathJoin } from "node:path";

export const BASE_DIR = join(homedir(), ".lossless-claude");

export const projectId = (cwd: string): string =>
  createHash("sha256").update(cwd).digest("hex");

export const projectDir = (cwd: string): string =>
  join(BASE_DIR, "projects", projectId(cwd));

export const projectDbPath = (cwd: string): string =>
  join(projectDir(cwd), "db.sqlite");

export const projectMetaPath = (cwd: string): string =>
  join(projectDir(cwd), "meta.json");

function tryRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function isSafeTranscriptPath(transcriptPath: string, cwd: string): string | false {
  const resolved = resolve(transcriptPath);

  // Check for symlinks: if the resolved path is a symlink, follow it and re-validate.
  let lstat: ReturnType<typeof lstatSync> | null = null;
  try { lstat = lstatSync(resolved); } catch { /* file doesn't exist */ }

  if (lstat?.isSymbolicLink()) {
    // Follow symlink to real path and re-validate against allowed bases
    let real: string;
    try { real = realpathSync(resolved); } catch { return false; }
    const allowedBases = [
      tryRealpath(pathJoin(homedir(), ".claude", "projects")),
      tryRealpath(resolve(cwd)),
    ];
    for (const base of allowedBases) {
      const normalBase = normalize(base + "/");
      if (real.startsWith(normalBase) || real === normalize(base)) {
        return real;
      }
    }
    return false;
  }

  // Not a symlink (or doesn't exist yet): validate using resolve() — consistent with cwd.
  const allowedBases = [
    pathJoin(homedir(), ".claude", "projects"),
    resolve(cwd),
  ];
  for (const base of allowedBases) {
    const normalBase = normalize(base + "/");
    if (resolved.startsWith(normalBase) || resolved === normalize(base)) {
      return resolved;
    }
  }
  return false;
}

/** Ensures the project dir exists and writes cwd to meta.json. */
export const ensureProjectDir = (cwd: string): string => {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, "meta.json");
  let meta: Record<string, unknown> = { cwd };
  if (existsSync(metaPath)) {
    try { meta = { ...JSON.parse(readFileSync(metaPath, "utf-8")), cwd }; } catch { /* keep default */ }
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return dir;
};
