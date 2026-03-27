import type { DatabaseSync } from "node:sqlite";

export function upsertRedactionCounts(
  db: DatabaseSync,
  projectId: string,
  counts: { gitleaks: number; builtIn: number; global: number; project: number },
): void {
  if (counts.gitleaks === 0 && counts.builtIn === 0 && counts.global === 0 && counts.project === 0) return;
  const upsert = db.prepare(`
    INSERT INTO redaction_stats (project_id, category, count)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, category) DO UPDATE SET count = count + excluded.count
  `);
  if (counts.gitleaks > 0) upsert.run(projectId, "gitleaks", counts.gitleaks);
  if (counts.builtIn > 0) upsert.run(projectId, "built_in", counts.builtIn);
  if (counts.global > 0) upsert.run(projectId, "global", counts.global);
  if (counts.project > 0) upsert.run(projectId, "project", counts.project);
}
