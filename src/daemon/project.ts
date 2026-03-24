import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const BASE_DIR = join(homedir(), ".lossless-claude");

export const projectId = (cwd: string): string =>
  createHash("sha256").update(cwd).digest("hex");

export const projectDir = (cwd: string): string =>
  join(BASE_DIR, "projects", projectId(cwd));

export const projectDbPath = (cwd: string): string =>
  join(projectDir(cwd), "db.sqlite");

export const projectMetaPath = (cwd: string): string =>
  join(projectDir(cwd), "meta.json");

/**
 * Returns true if transcriptPath is a string that resolves to a location under
 * one of the two allowed bases: ~/.claude/projects/ (standard Claude Code sessions)
 * or the project's own cwd directory. Rejects path traversal sequences and
 * out-of-bounds paths before they are passed to existsSync / parseTranscript.
 */
export function isSafeTranscriptPath(transcriptPath: unknown, cwd: string): transcriptPath is string {
  if (typeof transcriptPath !== "string" || !transcriptPath) return false;
  const resolved = resolve(transcriptPath);
  const allowedBases = [
    join(homedir(), ".claude", "projects"),
    resolve(cwd),
  ];
  return allowedBases.some((base) => resolved === base || resolved.startsWith(base + sep));
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
