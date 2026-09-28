import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LcmPaths } from "../lcm-paths.js";
import type { CheckResult } from "./types.js";

/** Read-only inventory of rebuild copies beside each project database. */
export function checkRebuildBackups(paths: LcmPaths): CheckResult {
  const base = { name: "rebuild-backups", category: "Storage" } as const;
  let projects;
  try {
    projects = readdirSync(paths.projectsDir, { withFileTypes: true });
  } catch {
    return { ...base, status: "pass", message: "No rebuild backups found" };
  }
  const lines: string[] = [];
  let extra = false;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(paths.projectsDir, project.name);
    const backups = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("db.sqlite.bak-rebuild-"));
    if (backups.length === 0) continue;
    const bytes = backups.reduce((total, entry) => total + statSync(join(dir, entry.name)).size, 0);
    if (backups.length > 1) extra = true;
    lines.push(`     ${dir}: ${backups.length} backup${backups.length === 1 ? "" : "s"}, ${formatBytes(bytes)}`);
  }
  if (lines.length === 0) return { ...base, status: "pass", message: "No rebuild backups found" };
  // A rebuild keeps one copy per project on purpose; more than one predates that retention.
  return {
    ...base, status: extra ? "warn" : "pass",
    message: `Rebuild backups by project:\n${lines.join("\n")}\n` +
      "     Remove: delete db.sqlite.bak-rebuild-* in each listed project directory after confirming they are no longer needed",
  };
}

function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
