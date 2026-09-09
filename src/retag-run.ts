import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BASE_DIR, claudeTranscriptPath, projectDbPath } from "./daemon/project.js";
import { runLcmMigrations } from "./db/migration.js";
import { retagConversation, type RetagOutcome } from "./retag.js";

export interface RetagRunOptions {
  /** Limit to one project; otherwise every project on disk. */
  cwd?: string;
  /** Report what would change without writing. */
  dryRun?: boolean;
  onProject?: (cwd: string, totals: RetagTotals) => void;
}

export interface RetagTotals {
  conversations: number;
  retaggedConversations: number;
  rows: number;
  skipped: Record<string, number>;
}

const emptyTotals = (): RetagTotals => ({
  conversations: 0,
  retaggedConversations: 0,
  rows: 0,
  skipped: {},
});

function add(into: RetagTotals, from: RetagTotals): void {
  into.conversations += from.conversations;
  into.retaggedConversations += from.retaggedConversations;
  into.rows += from.rows;
  for (const [reason, n] of Object.entries(from.skipped)) {
    into.skipped[reason] = (into.skipped[reason] ?? 0) + n;
  }
}

function record(totals: RetagTotals, outcome: RetagOutcome): void {
  totals.conversations++;
  if (outcome.skipped) {
    totals.skipped[outcome.skipped] = (totals.skipped[outcome.skipped] ?? 0) + 1;
    return;
  }
  if (outcome.retagged > 0) {
    totals.retaggedConversations++;
    totals.rows += outcome.retagged;
  }
}

/**
 * Re-labels one project's untagged conversations from the transcripts that
 * still exist on disk.
 *
 * A session with no transcript is never touched: its rows cannot be checked
 * against anything, so they keep the labels they have and the conversation
 * stays unknown.
 */
export function retagProject(cwd: string, options: { dryRun?: boolean } = {}): RetagTotals {
  const totals = emptyTotals();
  const dbPath = projectDbPath(cwd);
  if (!existsSync(dbPath)) return totals;

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    runLcmMigrations(db);
    const conversations = db
      .prepare("SELECT conversation_id, session_id FROM conversations WHERE role_tagging IS NULL")
      .all() as unknown as Array<{ conversation_id: number; session_id: string }>;

    for (const conversation of conversations) {
      const transcript = claudeTranscriptPath(cwd, conversation.session_id);
      if (!transcript || !existsSync(transcript)) {
        totals.conversations++;
        totals.skipped["no-transcript"] = (totals.skipped["no-transcript"] ?? 0) + 1;
        continue;
      }
      if (options.dryRun) {
        // A dry run answers the only question that matters — how many rows
        // would change — so it does the same comparison inside a rolled-back
        // transaction rather than a weaker one outside it.
        db.exec("SAVEPOINT retag_dry_run");
        try {
          record(totals, retagConversation(db, conversation.conversation_id, transcript));
        } finally {
          db.exec("ROLLBACK TO retag_dry_run");
          db.exec("RELEASE retag_dry_run");
        }
        continue;
      }
      record(totals, retagConversation(db, conversation.conversation_id, transcript));
    }
  } finally {
    db.close();
  }
  return totals;
}

/** Re-labels every project on disk, or the one named. */
export function retagAll(options: RetagRunOptions = {}): RetagTotals {
  const overall = emptyTotals();
  const cwds = options.cwd ? [options.cwd] : projectCwds();

  for (const cwd of cwds) {
    const totals = retagProject(cwd, { dryRun: options.dryRun });
    if (totals.conversations === 0) continue;
    options.onProject?.(cwd, totals);
    add(overall, totals);
  }
  return overall;
}

function projectCwds(): string[] {
  const projectsDir = join(BASE_DIR, "projects");
  if (!existsSync(projectsDir)) return [];
  const cwds: string[] = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(projectsDir, entry.name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const cwd = JSON.parse(readFileSync(metaPath, "utf-8")).cwd;
      if (typeof cwd === "string" && cwd) cwds.push(cwd);
    } catch {
      // A corrupt meta.json skips that project, never the whole run.
    }
  }
  return cwds;
}
