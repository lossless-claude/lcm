import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import { doctorList } from "./bounded-list.js";
import type { CheckResult } from "./types.js";

/** Copies a rebuild keeps per project database: the oldest and the newest. */
const MAX_KEPT = 2;

/** Read-only inventory of rebuild copies beside each project database. */
export function checkRebuildBackups(paths: LcmPaths, verbose = false): CheckResult {
  const base = { name: "rebuild-backups", category: "Storage" } as const;
  let projects;
  try {
    projects = readdirSync(paths.projectsDir, { withFileTypes: true });
  } catch {
    return { ...base, status: "pass", message: "No rebuild backups found" };
  }
  const found = projects
    .filter((project) => project.isDirectory())
    .map((project) => projectBackups(join(paths.projectsDir, project.name)))
    .filter((entry) => entry !== undefined);
  if (found.length === 0) return { ...base, status: "pass", message: "No rebuild backups found" };
  const lines = doctorList(found, verbose, entry => entry.line);
  // A rebuild keeps the oldest and the newest copy per project; more than that predates the retention.
  return {
    ...base, status: found.some((entry) => entry.extra) ? "warn" : "pass",
    message: `Rebuild backups by project:\n${lines.join("\n")}\n` +
      "     Remove: delete db.sqlite.bak-rebuild-* in each listed project directory after confirming they are no longer needed",
  };
}

/** One project's line, or undefined when it holds no rebuild backup. An unreadable directory is listed, not fatal. */
function projectBackups(dir: string): { line: string; extra: boolean } | undefined {
  try {
    const backups = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("db.sqlite.bak-rebuild-"));
    if (backups.length === 0) return undefined;
    const bytes = backups.reduce((total, entry) => total + statSync(join(dir, entry.name)).size, 0);
    return {
      line: `     ${dir}: ${backups.length} backup${backups.length === 1 ? "" : "s"}, ${formatBytes(bytes)}`,
      extra: backups.length > MAX_KEPT,
    };
  } catch {
    return { line: `     ${dir}: not checked (unreadable)`, extra: false };
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
