import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, normalize, join as pathJoin, dirname, basename } from "node:path";

const resolveBaseDir = (): string =>
  process.env.LCM_DATA_DIR ?? join(homedir(), ".lossless-claude");

/** Snapshot for callers that need a fixed path (e.g. daemon startup). Tests override via LCM_DATA_DIR. */
export const BASE_DIR = resolveBaseDir();

function canonicalizeCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

export const projectId = (cwd: string): string =>
  createHash("sha256").update(canonicalizeCwd(cwd)).digest("hex");

export const projectDir = (cwd: string): string =>
  join(resolveBaseDir(), "projects", projectId(cwd));

export const projectDbPath = (cwd: string): string =>
  join(projectDir(cwd), "db.sqlite");

export const projectMetaPath = (cwd: string): string =>
  join(projectDir(cwd), "meta.json");

function tryRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Like realpathSync but handles non-existent paths by resolving the nearest
 * existing ancestor and appending the remaining components.
 * This ensures symlinked parent directories are resolved even when the leaf
 * path doesn't exist yet (e.g. a transcript file not yet created).
 */
function realpathDeep(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  // Walk up to find the nearest existing ancestor, then reconstruct
  const parts: string[] = [];
  let cur = p;
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached root
    parts.unshift(basename(cur));
    cur = parent;
    try {
      const real = realpathSync(cur);
      return join(real, ...parts);
    } catch { /* keep walking up */ }
  }
  return p; // fallback: return original
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
  // Canonicalize both the candidate path and the allowed bases via realpathSync so that
  // a symlinked parent directory (e.g. /tmp -> /private/tmp on macOS) doesn't create
  // a bypass in either direction.
  // Use realpathDeep so non-existent leaf paths still get their parent directories
  // resolved (e.g. /tmp/transcript.jsonl -> /private/tmp/transcript.jsonl on macOS).
  const candidate = realpathDeep(resolved);
  const allowedBases = [
    tryRealpath(pathJoin(homedir(), ".claude", "projects")),
    tryRealpath(resolve(cwd)),
  ];
  for (const base of allowedBases) {
    const normalBase = normalize(base + "/");
    if (candidate.startsWith(normalBase) || candidate === normalize(base)) {
      return candidate;
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
