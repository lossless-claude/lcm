/**
 * Portable knowledge: export and import promoted memory entries.
 *
 * Export format:
 *   {
 *     version: 1,
 *     exportedAt: "<ISO string>",
 *     projectCwd: "<string>",
 *     entries: [{ content, tags, confidence, createdAt, sessionId }]
 *   }
 *
 * Secrets are scrubbed on export via ScrubEngine.
 * Deduplication is performed on import via deduplicateAndInsert().
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { PromotedStore } from "./db/promoted.js";
import { runLcmMigrations } from "./db/migration.js";
import { deduplicateAndInsert } from "./promotion/dedup.js";
import { ScrubEngine } from "./scrub.js";

export const EXPORT_VERSION = 1;

export interface ExportEntry {
  content: string;
  tags: string[];
  confidence: number;
  createdAt: string;
  sessionId: string | null;
}

export interface ExportDocument {
  version: number;
  exportedAt: string;
  projectCwd: string;
  entries: ExportEntry[];
}

// ─── Internal helpers (accept optional baseDir for testing) ──────────────────

function canonicalizeCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

function resolveProjectId(cwd: string): string {
  return createHash("sha256").update(canonicalizeCwd(cwd)).digest("hex");
}

function resolveProjectDir(cwd: string, baseDir: string): string {
  return join(baseDir, "projects", resolveProjectId(cwd));
}

function resolveProjectDbPath(cwd: string, baseDir: string): string {
  return join(resolveProjectDir(cwd, baseDir), "db.sqlite");
}

function defaultBaseDir(): string {
  return join(homedir(), ".lossless-claude");
}

// ─── Export ──────────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Only include entries with these tags */
  tags?: string[];
  /** Only include entries created at or after this ISO date string */
  since?: string;
  /** Output file path (stdout if omitted) */
  output?: string;
  /** Output format — only "json" supported for now */
  format?: "json";
  /** Skip scrubbing secrets (not recommended; useful for tests) */
  skipScrub?: boolean;
  /** Override the ~/.lossless-claude base directory (for testing) */
  _lcmBaseDir?: string;
}

export interface ExportResult {
  exported: number;
  projectCwd: string;
}

export async function exportKnowledge(
  cwd: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const baseDir = opts._lcmBaseDir ?? defaultBaseDir();
  const dbPath = resolveProjectDbPath(cwd, baseDir);

  if (!existsSync(dbPath)) {
    throw new Error(`No lossless-claude database found for project: ${cwd}`);
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  runLcmMigrations(db);

  const store = new PromotedStore(db);
  const projId = resolveProjectId(cwd);

  const rows = store.getAll({
    projectId: projId,
    since: opts.since,
    tags: opts.tags,
  });

  // Build scrubber for secret redaction
  let scrubber: ScrubEngine | null = null;
  if (!opts.skipScrub) {
    const projDir = resolveProjectDir(cwd, baseDir);
    scrubber = await ScrubEngine.forProject([], projDir);
  }

  const entries: ExportEntry[] = rows.map((r) => {
    let content = r.content;
    if (scrubber) {
      content = scrubber.scrub(content);
    }
    return {
      content,
      tags: JSON.parse(r.tags) as string[],
      confidence: r.confidence,
      createdAt: r.created_at,
      sessionId: r.session_id,
    };
  });

  const doc: ExportDocument = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projectCwd: cwd,
    entries,
  };

  const json = JSON.stringify(doc, null, 2);

  if (opts.output) {
    writeFileSync(opts.output, json, "utf-8");
  } else {
    process.stdout.write(json + "\n");
  }

  db.close();

  return { exported: entries.length, projectCwd: cwd };
}

// ─── Import ──────────────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Merge with existing entries, deduplicating (default behaviour) */
  merge?: boolean;
  /** Preview without writing anything */
  dryRun?: boolean;
  /** Override confidence for all imported entries */
  confidence?: number;
  /** Override the ~/.lossless-claude base directory (for testing) */
  _lcmBaseDir?: string;
}

export interface ImportResult {
  total: number;
  imported: number;
  skipped: number;
  dryRun: boolean;
}

const DEFAULT_DEDUP_THRESHOLDS = {
  dedupBm25Threshold: 15,
  dedupCandidateLimit: 100,
};

export async function importKnowledge(
  cwd: string,
  doc: ExportDocument,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (doc.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${doc.version} (expected ${EXPORT_VERSION})`);
  }

  if (opts.dryRun) {
    return {
      total: doc.entries.length,
      imported: doc.entries.length,
      skipped: 0,
      dryRun: true,
    };
  }

  const baseDir = opts._lcmBaseDir ?? defaultBaseDir();
  const projDir = resolveProjectDir(cwd, baseDir);
  const dbPath = resolveProjectDbPath(cwd, baseDir);

  // Ensure project dir + DB exist
  mkdirSync(projDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  runLcmMigrations(db);

  const store = new PromotedStore(db);
  const projId = resolveProjectId(cwd);

  let imported = 0;
  let skipped = 0;

  for (const entry of doc.entries) {
    const confidence = opts.confidence !== undefined ? opts.confidence : entry.confidence;
    try {
      await deduplicateAndInsert({
        store,
        content: entry.content,
        tags: entry.tags,
        projectId: projId,
        sessionId: entry.sessionId ?? undefined,
        depth: 0,
        confidence,
        thresholds: DEFAULT_DEDUP_THRESHOLDS,
      });
      imported++;
    } catch {
      skipped++;
    }
  }

  db.close();

  return {
    total: doc.entries.length,
    imported,
    skipped,
    dryRun: false,
  };
}
