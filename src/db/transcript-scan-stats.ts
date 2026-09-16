import type { DatabaseSync } from "node:sqlite";
import { closeLcmConnection, getLcmConnection } from "./connection.js";
import { runLcmMigrations } from "./migration.js";
import { projectDbPath } from "../daemon/project.js";
import { openProject } from "../daemon/project-group.js";
import type { LcmPaths } from "../lcm-paths.js";

export interface TranscriptScanCounts {
  transcriptsSeen: number;
  subagentExcluded: number;
  ingested: number;
  skipped: number;
}

export function addTranscriptScanStats(db: DatabaseSync, counts: TranscriptScanCounts): void {
  if (counts.transcriptsSeen === 0) return;
  db.prepare(`
    INSERT INTO transcript_scan_stats (
      id, transcripts_seen, subagent_excluded, ingested, skipped
    ) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      transcripts_seen = transcripts_seen + excluded.transcripts_seen,
      subagent_excluded = subagent_excluded + excluded.subagent_excluded,
      ingested = ingested + excluded.ingested,
      skipped = skipped + excluded.skipped
  `).run(
    counts.transcriptsSeen,
    counts.subagentExcluded,
    counts.ingested,
    counts.skipped,
  );
}

export function recordTranscriptScanStats(
  cwd: string,
  paths: LcmPaths,
  counts: TranscriptScanCounts,
  claudeProjectsDir?: string,
): void {
  if (counts.transcriptsSeen === 0) return;

  openProject(cwd, paths);
  const dbPath = projectDbPath(cwd, paths);
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db, { claudeProjectsDir });
    addTranscriptScanStats(db, counts);
  } finally {
    closeLcmConnection(dbPath);
  }
}
