import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { buildOrientationPrompt } from "../orientation.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { justCompactedMap, JUST_COMPACTED_TTL_MS } from "./compact.js";

type SessionInstructionsRow = {
  content: string;
  content_hash: string;
  updated_at: string;
};

function readClaudeMdFiles(cwd: string): string {
  const paths = [
    { label: "~/.claude/CLAUDE.md", path: join(homedir(), ".claude", "CLAUDE.md") },
    { label: `${cwd}/CLAUDE.md`, path: join(cwd, "CLAUDE.md") },
    { label: `${cwd}/.claude/CLAUDE.md`, path: join(cwd, ".claude", "CLAUDE.md") },
  ];

  const parts: string[] = [];
  for (const { label, path } of paths) {
    try {
      const content = readFileSync(path, "utf8");
      parts.push(`# ${label}\n${content}`);
    } catch {
      // file doesn't exist or can't be read — skip silently
    }
  }

  return parts.join("\n\n");
}

export function createRestoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}");
      const { session_id, cwd, source } = input;
      const orientation = buildOrientationPrompt();

      // Post-compaction detection
      const isPostCompact =
        source === "compact" ||
        (justCompactedMap.has(session_id) && Date.now() - justCompactedMap.get(session_id)! < JUST_COMPACTED_TTL_MS);

      // Query session_instructions for compact/resume paths
      let instructionsContext = "";
      if (cwd) {
        const dbPath = projectDbPath(cwd);
        if (existsSync(dbPath)) {
          try {
            const db = new DatabaseSync(dbPath);
            try {
              runLcmMigrations(db);
              const row = db
                .prepare(`SELECT content, content_hash, updated_at FROM session_instructions WHERE id = 1`)
                .get() as SessionInstructionsRow | undefined;
              if (row) {
                instructionsContext = `<project-instructions>\n${row.content}\n</project-instructions>`;
              }
            } finally {
              db.close();
            }
          } catch { /* non-fatal */ }
        }
      }

      if (isPostCompact) {
        const context = [orientation, instructionsContext].filter(Boolean).join("\n\n");
        sendJson(res, 200, { context });
        return;
      }

      let episodicContext = "";
      let promotedContext = "";

      // Episodic: query recent summaries from project SQLite DB
      // Also capture CLAUDE.md files on startup
      if (cwd) {
        const dbPath = projectDbPath(cwd);
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        try {
          runLcmMigrations(db);

          const rows = db.prepare(
            `SELECT s.content FROM summaries s
             JOIN conversations c ON s.conversation_id = c.conversation_id
             WHERE c.session_id = ?
             ORDER BY s.depth DESC, s.created_at DESC
             LIMIT ?`,
          ).all(session_id, config.restoration.recentSummaries) as Array<{ content: string }>;

          if (rows.length > 0) {
            episodicContext = `<recent-session-context>\n${rows.map((r) => r.content).join("\n\n")}\n</recent-session-context>`;
          }

          // Promoted: cross-session knowledge from SQLite
          try {
            const promotedStore = new PromotedStore(db);
            const results = promotedStore.search(`project context ${cwd}`, 5);
            if (results.length > 0) {
              promotedContext = `<project-knowledge>\n${results.map((r) => r.content).join("\n\n")}\n</project-knowledge>`;
            }
          } catch { /* non-fatal */ }

          // Capture CLAUDE.md files and upsert into session_instructions if changed
          try {
            const claudeMdContent = readClaudeMdFiles(cwd);
            if (claudeMdContent) {
              const hash = createHash("sha256").update(claudeMdContent).digest("hex");
              const existing = db
                .prepare(`SELECT content_hash FROM session_instructions WHERE id = 1`)
                .get() as { content_hash: string } | undefined;

              if (!existing || existing.content_hash !== hash) {
                db.prepare(
                  `INSERT INTO session_instructions (id, content, content_hash, updated_at)
                   VALUES (1, ?, ?, datetime('now'))
                   ON CONFLICT(id) DO UPDATE SET
                     content = excluded.content,
                     content_hash = excluded.content_hash,
                     updated_at = excluded.updated_at`,
                ).run(claudeMdContent, hash);
              }
            }
          } catch { /* non-fatal */ }

          db.close();
        } catch { /* non-fatal */ }
      }

      const context = [orientation, episodicContext, promotedContext, instructionsContext].filter(Boolean).join("\n\n");
      sendJson(res, 200, { context });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}
