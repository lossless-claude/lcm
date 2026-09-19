import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, normalize, join as pathJoin, dirname, basename } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";

function canonicalizeCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

export const projectId = (cwd: string): string =>
  createHash("sha256").update(canonicalizeCwd(cwd)).digest("hex");

export const projectDir = (cwd: string, paths: LcmPaths): string =>
  join(paths.projectsDir, projectId(cwd));

export const projectDbPath = (cwd: string, paths: LcmPaths): string =>
  join(projectDir(cwd, paths), "db.sqlite");

export const projectMetaPath = (cwd: string, paths: LcmPaths): string =>
  join(projectDir(cwd, paths), "meta.json");

/**
 * Where Claude Code writes a session's transcript: ~/.claude/projects/<cwd with every
 * non-alphanumeric character replaced by "-">/<session_id>.jsonl. Used when a caller knows
 * the session but not the file (the function-hooks module has `$.session.id()` and
 * `$.session.cwd()`, not `transcript_path`). Returns null for a session id that is not a
 * plain file name.
 */
export function claudeTranscriptPath(cwd: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const projectSlug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", projectSlug, `${sessionId}.jsonl`);
}

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

export function isSafeTranscriptPath(transcriptPath: string, cwd: string, client: "claude" | "codex" = "claude"): string | false {
  const resolved = resolve(transcriptPath);
  const transcriptBases = client === "codex"
    ? [pathJoin(homedir(), ".codex", "sessions"), pathJoin(homedir(), ".codex", "archived_sessions")]
    : [pathJoin(homedir(), ".claude", "projects")];

  // Check for symlinks: if the resolved path is a symlink, follow it and re-validate.
  let lstat: ReturnType<typeof lstatSync> | null = null;
  try { lstat = lstatSync(resolved); } catch { /* file doesn't exist */ }

  if (lstat?.isSymbolicLink()) {
    // Follow symlink to real path and re-validate against allowed bases
    let real: string;
    try { real = realpathSync(resolved); } catch { return false; }
    const allowedBases = [
      ...transcriptBases.map(tryRealpath),
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
    ...transcriptBases.map(tryRealpath),
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

/**
 * Ensures the project dir exists. The project's record (`meta.json`) is owned by
 * `project-meta.ts`, which this module must not import: it would form a cycle
 * through `projectMetaPath`, and a test that mocks this module would then see
 * the record written somewhere else. `openProject` records `cwd`.
 */
export const ensureProjectDir = (cwd: string, paths: LcmPaths): string => {
  const dir = projectDir(cwd, paths);
  mkdirSync(dir, { recursive: true });
  return dir;
};
