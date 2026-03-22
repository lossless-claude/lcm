import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BASE_DIR = join(homedir(), ".lossless-claude");

export const projectId = (cwd: string): string =>
  createHash("sha256").update(cwd).digest("hex");

export const projectDir = (cwd: string): string =>
  join(BASE_DIR, "projects", projectId(cwd));

export const projectDbPath = (cwd: string): string =>
  join(projectDir(cwd), "db.sqlite");

export const projectMetaPath = (cwd: string): string =>
  join(projectDir(cwd), "meta.json");

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
