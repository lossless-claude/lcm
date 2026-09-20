import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fenceContent } from "../content-fence.js";

/**
 * The CLAUDE.md snapshot: the project's instruction files as they were when a restore last
 * saw them. `/compact` takes the harness's own copy away, so the restore that follows it
 * replays this one; every other restore refreshes it without echoing it back.
 */

type SessionInstructionsRow = {
  content: string;
  content_hash: string;
  updated_at: string;
};

/** The instruction files a session start would have loaded, in the order the harness reads them. */
function readClaudeMdFiles(cwd: string): string {
  const paths = [
    { label: "~/.claude/CLAUDE.md", path: join(homedir(), ".claude", "CLAUDE.md") },
    { label: `${cwd}/CLAUDE.md`, path: join(cwd, "CLAUDE.md") },
    { label: `${cwd}/.claude/CLAUDE.md`, path: join(cwd, ".claude", "CLAUDE.md") },
  ];

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const { label, path } of paths) {
    try {
      // When cwd is $HOME, entries 1 and 3 are the same file; reading it twice duplicates
      // it in the snapshot, and so in every replay of that snapshot. Key on the canonical
      // path, not the spelling: cwd arrives realpath'd from validateCwd while homedir()
      // does not, so the same file can reach here as both /var/… and /private/var/….
      const key = realpathSync(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const content = readFileSync(path, "utf8");
      parts.push(`# ${label}\n${content}`);
    } catch {
      // file doesn't exist or can't be read — skip silently
    }
  }

  return parts.join("\n\n");
}

/** The snapshot, fenced, or empty when none was ever captured. */
export function readInstructionsSnapshot(db: DatabaseSync): string {
  const row = db
    .prepare(`SELECT content, content_hash, updated_at FROM session_instructions WHERE id = 1`)
    .get() as SessionInstructionsRow | undefined;
  return row ? fenceContent(row.content, "project-instructions") : "";
}

/** Keeps the snapshot current, so the next compaction has something to replay. */
export function refreshInstructionsSnapshot(db: DatabaseSync, cwd: string): void {
  try {
    const content = readClaudeMdFiles(cwd);
    if (!content) return;
    const hash = createHash("sha256").update(content).digest("hex");
    const existing = db
      .prepare(`SELECT content_hash FROM session_instructions WHERE id = 1`)
      .get() as { content_hash: string } | undefined;
    if (existing?.content_hash === hash) return;
    db.prepare(
      `INSERT INTO session_instructions (id, content, content_hash, updated_at)
       VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
    ).run(content, hash);
  } catch { /* Non-fatal: the snapshot is for the next compaction, not for this restore. */ }
}