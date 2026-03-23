import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { DaemonClient } from "./daemon/client.js";

interface ImportOptions {
  all?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  cwd?: string;
  /** Override ~/.claude/projects path — used in tests only */
  _claudeProjectsDir?: string;
  /** Override ~/.lossless-claude path — used in tests only */
  _lcmDir?: string;
}

interface ImportResult {
  imported: number;
  skippedEmpty: number;
  failed: number;
  totalMessages: number;
}

export function cwdToProjectHash(cwd: string): string {
  // Claude Code uses the cwd with slashes replaced by dashes, keeping the leading dash
  // e.g. /Users/pedro/Developer/lossless-claude → -Users-pedro-Developer-lossless-claude
  return cwd.replace(/\//g, '-');
}

function buildProjectMap(lcmDir?: string): Map<string, string> {
  const lcmProjectsDir = join(lcmDir ?? join(homedir(), '.lossless-claude'), 'projects');
  const map = new Map<string, string>();
  if (!existsSync(lcmProjectsDir)) return map;
  for (const entry of readdirSync(lcmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = join(lcmProjectsDir, entry.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.cwd) {
        const hash = cwdToProjectHash(meta.cwd);
        map.set(hash, meta.cwd);
      }
    } catch {}
  }
  return map;
}

export function findSessionFiles(projectDir: string): { path: string; sessionId: string; mtime: number }[] {
  const files: { path: string; sessionId: string; mtime: number }[] = [];
  if (!existsSync(projectDir)) return files;

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push({
        path: join(projectDir, entry.name),
        sessionId: basename(entry.name, '.jsonl'),
        mtime: statSync(join(projectDir, entry.name)).mtimeMs,
      });
    }
    if (entry.isDirectory()) {
      const subagentsDir = join(projectDir, entry.name, 'subagents');
      if (existsSync(subagentsDir)) {
        for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            files.push({
              path: join(subagentsDir, sub.name),
              sessionId: basename(sub.name, '.jsonl'),
              mtime: statSync(join(subagentsDir, sub.name)).mtimeMs,
            });
          }
        }
      }
    }
  }
  return files.sort((a, b) => a.mtime - b.mtime);
}

export async function importSessions(
  client: DaemonClient,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const claudeProjectsDir = options._claudeProjectsDir ?? join(homedir(), '.claude', 'projects');
  const result: ImportResult = { imported: 0, skippedEmpty: 0, failed: 0, totalMessages: 0 };

  const projectDirs: { dir: string; cwd: string }[] = [];

  if (options.all) {
    if (!existsSync(claudeProjectsDir)) return result;
    const projectMap = buildProjectMap(options._lcmDir);
    for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cwd = projectMap.get(entry.name);
      if (!cwd) continue;
      projectDirs.push({ dir: join(claudeProjectsDir, entry.name), cwd });
    }
  } else {
    const cwd = options.cwd ?? process.cwd();
    const hash = cwdToProjectHash(cwd);
    const dir = join(claudeProjectsDir, hash);
    if (existsSync(dir)) {
      projectDirs.push({ dir, cwd });
    }
  }

  for (const { dir, cwd } of projectDirs) {
    const sessionFiles = findSessionFiles(dir);

    for (const { path, sessionId } of sessionFiles) {
      if (options.dryRun) {
        if (options.verbose) console.log(`  [dry-run] ${sessionId}`);
        result.imported++;
        continue;
      }

      try {
        const res = await client.post<{ ingested: number; totalTokens: number }>('/ingest', {
          session_id: sessionId,
          cwd,
          transcript_path: path,
        });
        if (res.ingested === 0 && res.totalTokens === 0) {
          result.skippedEmpty++;
          if (options.verbose) console.log(`  \u2298 ${sessionId}: empty or already ingested`);
        } else {
          result.imported++;
          result.totalMessages += res.ingested;
          if (options.verbose) console.log(`  \u2713 ${sessionId}: ${res.ingested} messages`);
        }
      } catch (err) {
        result.failed++;
        if (options.verbose) console.log(`  \u2717 ${sessionId}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
  }

  return result;
}
