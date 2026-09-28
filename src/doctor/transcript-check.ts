// src/doctor/transcript-check.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CheckResult } from "./types.js";
import type { LcmPaths } from "../lcm-paths.js";
import { claudeProjectSlug, projectDbPath, projectId } from "../daemon/project.js";
import { readProjectMetaIn } from "../daemon/project-meta.js";
import { closeLcmConnection, getLcmConnection } from "../db/connection.js";
import { findSessionFiles, type DiscoveredSessionFile } from "../import.js";
import { completedSinceModified } from "../capture.js";

/**
 * A transcript modified more recently than this is left out: its session may be in
 * progress, and the periodic transcript scan (every 10 minutes) has not had a pass at
 * it yet.
 */
export const SETTLED_MS = 15 * 60 * 1000;

type Behind = { cwd: string; count: number; newest: DiscoveredSessionFile };

/** Session ids with at least one stored message: one pass over `conversations`. */
function storedSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(
    "SELECT DISTINCT c.session_id AS id FROM conversations c WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.conversation_id)",
  ).all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Every session's `completed_at`, in one query. */
function completions(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare("SELECT session_id, completed_at FROM session_ingest_log").all() as Array<{ session_id: string; completed_at: string }>;
  return new Map(rows.map((row) => [row.session_id, row.completed_at]));
}

/**
 * The settled transcripts of one project with no message stored and no completion since
 * the file last changed (the rule `isSessionComplete` applies). A project without a
 * database has stored nothing, so every settled transcript counts.
 */
function uncaptured(files: DiscoveredSessionFile[], dbPath: string): DiscoveredSessionFile[] {
  if (files.length === 0 || !existsSync(dbPath)) return files;
  const db = getLcmConnection(dbPath, { readOnly: true });
  try {
    const stored = storedSessionIds(db);
    const completed = completions(db);
    return files.filter((file) => {
      if (stored.has(file.sessionId)) return false;
      const completedAt = completed.get(file.sessionId);
      return completedAt === undefined || !completedSinceModified(completedAt, file.mtime);
    });
  } finally {
    closeLcmConnection(dbPath, { readOnly: true });
  }
}

/**
 * Every project lcm tracks, by cwd, plus `cwd` itself when lcm has no readable project for
 * it. A project directory whose `meta.json` cannot be read is reported, not fatal.
 */
function projectCwds(paths: LcmPaths, cwd: string): { cwds: string[]; unreadable: string[] } {
  let names: string[] = [];
  try {
    names = readdirSync(paths.projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { /* no projects yet */ }
  const cwds: string[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    const dir = join(paths.projectsDir, name);
    try {
      const tracked = readProjectMetaIn(dir)?.cwd;
      if (tracked) cwds.push(tracked);
    } catch {
      unreadable.push(dir);
    }
  }
  const current = projectId(cwd);
  if (!cwds.some((tracked) => projectId(tracked) === current)) cwds.push(cwd);
  return { cwds, unreadable };
}

/**
 * Claude Code project directories more than one tracked project maps to. The slug is lossy,
 * so their transcripts cannot be attributed to either project (nor can `lcm import`).
 */
function sharedSlugs(cwds: string[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const slug of cwds.map(claudeProjectSlug)) (seen.has(slug) ? shared : seen).add(slug);
  return shared;
}

/**
 * Claude Code transcripts holding turns lcm never stored: a transcript, found as
 * `lcm import` finds them, whose session has no stored message and was not completed
 * since the file last changed. Read-only and bounded by the number of transcripts: it
 * lists directories, stats transcripts and reads subagent `.meta.json` sidecars, and
 * never reads a transcript. A transcript's modification time is not compared
 * with the stored messages', since Claude Code keeps appending lines that hold no message.
 */
export function checkUncapturedTranscripts(opts: { paths: LcmPaths; claudeProjectsDir: string; cwd: string; now?: number }): CheckResult {
  const settledBefore = (opts.now ?? Date.now()) - SETTLED_MS;
  const behind: Behind[] = [];
  const { cwds, unreadable } = projectCwds(opts.paths, opts.cwd);
  const shared = sharedSlugs(cwds);
  for (const cwd of cwds) {
    if (shared.has(claudeProjectSlug(cwd))) {
      unreadable.push(`${cwd} (shares its Claude Code project directory)`);
      continue;
    }
    try {
      const settled = findSessionFiles(join(opts.claudeProjectsDir, claudeProjectSlug(cwd))).filter((file) => file.mtime < settledBefore);
      const missing = uncaptured(settled, projectDbPath(cwd, opts.paths));
      // findSessionFiles sorts oldest first.
      if (missing.length > 0) behind.push({ cwd, count: missing.length, newest: missing[missing.length - 1] });
    } catch {
      unreadable.push(cwd);
    }
  }
  const base = { name: "claude-capture", category: "Capture" } as const;
  const skipped = unreadable.length > 0 ? `\n     Not checked: ${unreadable.join(", ")}` : "";
  if (behind.length === 0 && unreadable.length > 0) {
    return { ...base, status: "warn", message: `no uncaptured Claude Code transcript found in the projects checked${skipped}` };
  }
  if (behind.length === 0) {
    return { ...base, status: "pass", message: `every Claude Code transcript not modified in the last ${SETTLED_MS / 60_000} min is captured` };
  }
  const total = behind.reduce((sum, project) => sum + project.count, 0);
  const lines = behind.map(({ cwd, count, newest }) => `     ${cwd}: ${count} transcript${count === 1 ? "" : "s"}, most recent ${newest.path}`);
  return {
    ...base,
    status: "warn",
    message: `${total} Claude Code transcript${total === 1 ? "" : "s"} with nothing stored:\n${lines.join("\n")}${skipped}\n` +
      "     Fix: run `lcm import --provider claude` in each project above",
  };
}
