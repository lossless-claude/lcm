import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { buildOrientationPrompt } from "../orientation.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { PromotedStore } from "../../db/promoted.js";
import { wasSessionJustCompacted } from "../../db/session-compactions.js";
import { fenceContent } from "../content-fence.js";
import { validateCwd } from "../validate-cwd.js";

type SessionInstructionsRow = {
  content: string;
  content_hash: string;
  updated_at: string;
};

type CodexContextItemRow = {
  ordinal: number;
  item_type: "message" | "summary";
  role: "user" | "assistant" | null;
  content: string;
};

/** Reads the mark `/compact` left for this session, if this project has a DB at all. */
function wasJustCompacted(cwd: string | undefined, sessionId: string): boolean {
  if (!cwd) return false;
  const dbPath = projectDbPath(cwd);
  if (!existsSync(dbPath)) return false;
  try {
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      return wasSessionJustCompacted(db, sessionId);
    } finally {
      closeLcmConnection(dbPath);
    }
  } catch {
    return false; // A restore must never fail over its own hint.
  }
}

function fitFencedText(content: string, tag: string, byteBudget: number): string {
  const normalized = content.trim();
  const budget = Math.max(0, Math.floor(byteBudget));
  if (!normalized || budget === 0) return "";

  const full = fenceContent(normalized, tag);
  if (Buffer.byteLength(full, "utf8") <= budget) return full;

  const points = Array.from(normalized);
  let low = 0;
  let high = points.length;
  let best = "";
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = `${points.slice(0, middle).join("").trimEnd()}...`;
    const fenced = fenceContent(candidate, tag);
    if (Buffer.byteLength(fenced, "utf8") <= budget) {
      best = fenced;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function fitRecentContextItems(items: string[], tag: string, byteBudget: number): string {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  const selected: string[] = [];

  for (let index = normalized.length - 1; index >= 0; index--) {
    const candidate = [normalized[index], ...selected];
    const fenced = fenceContent(candidate.join("\n\n"), tag);
    if (Buffer.byteLength(fenced, "utf8") <= byteBudget) {
      selected.unshift(normalized[index]);
      continue;
    }
    if (selected.length === 0) {
      return fitFencedText(normalized[index], tag, byteBudget);
    }
    break;
  }

  return selected.length > 0 ? fenceContent(selected.join("\n\n"), tag) : "";
}

function remainingContextBudget(parts: string[], totalBudget: number): number {
  const used = Buffer.byteLength(parts.join("\n\n"), "utf8");
  const separator = parts.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0;
  return Math.max(0, Math.floor(totalBudget) - used - separator);
}

function readCodexContext(
  db: DatabaseSync,
  sessionId: unknown,
  source: unknown,
  itemLimit: number,
  byteBudget: number,
): string {
  const limit = Math.max(0, Math.floor(itemLimit));
  if (limit === 0) return "";
  const current = typeof sessionId === "string" && sessionId
    ? db.prepare(
        `SELECT conversation_id FROM conversations
         WHERE session_id = ?
         ORDER BY updated_at DESC, conversation_id DESC
         LIMIT 1`,
      ).get(sessionId) as { conversation_id: number } | undefined
    : undefined;
  const readRows = (conversationId: number): CodexContextItemRow[] => {
    const contextRows = db.prepare(
      `WITH ranked AS (
         SELECT ci.ordinal, ci.item_type, m.role, COALESCE(m.content, s.content) AS content,
                ROW_NUMBER() OVER (PARTITION BY ci.item_type ORDER BY ci.ordinal DESC) AS item_rank
         FROM context_items ci
         LEFT JOIN messages m ON ci.item_type = 'message' AND m.message_id = ci.message_id
         LEFT JOIN summaries s ON ci.item_type = 'summary' AND s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ((ci.item_type = 'summary' AND s.content IS NOT NULL)
             OR (ci.item_type = 'message' AND m.role IN ('user', 'assistant') AND m.content IS NOT NULL))
       )
       SELECT ordinal, item_type, role, content
       FROM ranked
       WHERE item_rank <= ?
       ORDER BY ordinal`,
    ).all(conversationId, limit) as unknown as CodexContextItemRow[];
    if (contextRows.length > 0) return contextRows;

    // Older imports may have messages but no materialized context_items. Those messages
    // are still useful when no summarizer has produced a context sequence yet.
    return (db.prepare(
      `SELECT seq AS ordinal, 'message' AS item_type, role, content
       FROM messages
       WHERE conversation_id = ? AND role IN ('user', 'assistant')
       ORDER BY seq DESC
       LIMIT ?`,
    ).all(conversationId, limit) as unknown as CodexContextItemRow[]).reverse();
  };

  let conversation = current;
  let rows = conversation ? readRows(conversation.conversation_id) : [];
  let isCurrentSession = rows.length > 0;

  // SessionStart can run after a metadata-only ingest has created the new conversation.
  // An empty shell must not mask the latest useful context from the same project.
  if (rows.length === 0 && source === "startup") {
    conversation = db.prepare(
      `SELECT c.conversation_id FROM conversations c
       WHERE c.session_id != ?
         AND (EXISTS (
           SELECT 1 FROM messages m
           WHERE m.conversation_id = c.conversation_id AND m.role IN ('user', 'assistant')
         ) OR EXISTS (
           SELECT 1 FROM summaries s WHERE s.conversation_id = c.conversation_id
         ))
       ORDER BY MAX(
         COALESCE((
           SELECT MAX(julianday(m.created_at)) FROM messages m
           WHERE m.conversation_id = c.conversation_id
             AND m.role IN ('user', 'assistant')
         ), -1),
         COALESCE((
           SELECT MAX(julianday(s.created_at)) FROM summaries s
           WHERE s.conversation_id = c.conversation_id
         ), -1)
       ) DESC, c.conversation_id DESC
       LIMIT 1`,
    ).get(typeof sessionId === "string" ? sessionId : "") as { conversation_id: number } | undefined;
    rows = conversation ? readRows(conversation.conversation_id) : [];
    isCurrentSession = false;
  }

  if (!conversation || rows.length === 0) return "";

  const items = rows.map((row) => row.item_type === "summary"
    ? `Summary:\n${row.content}`
    : `${row.role === "assistant" ? "Assistant" : "User"}:\n${row.content}`);
  const tag = isCurrentSession ? "recent-session-context" : "recent-project-context";
  return fitRecentContextItems(items, tag, byteBudget);
}

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

export function createRestoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}");
      const { session_id, source } = input;
      const isCodex = input.client === "codex";
      let cwd: string | undefined;
      if (input.cwd) {
        try {
          cwd = validateCwd(input.cwd);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
          return;
        }
      }
      const orientation = buildOrientationPrompt();
      const codexContextParts = orientation ? [orientation] : [];
      const codexContextBudget = config.restoration.maxInjectedMemoryBytes;

      // Explicit session lifecycle sources override the recent-compaction fallback.
      // `source` is absent whenever the function-hooks module asks: prompt.context carries
      // no reason for firing, so there the mark is the only thing that distinguishes a
      // post-compaction restore from a fresh one.
      const isExplicitNonCompact = source === "startup" || source === "resume" || source === "clear";
      const isPostCompact =
        source === "compact" || (!isExplicitNonCompact && wasJustCompacted(cwd, session_id));

      // Only post-compaction restore consumes the saved instructions.
      let instructionsContext = "";
      if (!isCodex && isPostCompact && cwd) {
        const dbPath = projectDbPath(cwd);
        if (existsSync(dbPath)) {
          try {
            const db = getLcmConnection(dbPath);
            try {
              runLcmMigrations(db);
              const row = db
                .prepare(`SELECT content, content_hash, updated_at FROM session_instructions WHERE id = 1`)
                .get() as SessionInstructionsRow | undefined;
              if (row) {
                instructionsContext = `<project-instructions>\n${row.content}\n</project-instructions>`;
              }
            } finally {
              closeLcmConnection(dbPath);
            }
          } catch { /* non-fatal */ }
        }
      }

      if (!isCodex && isPostCompact) {
        const context = [orientation, instructionsContext].filter(Boolean).join("\n\n");
        sendJson(res, 200, { context });
        return;
      }

      let episodicContext = "";
      let promotedContext = "";

      // Restore project-scoped episodic context. Claude also refreshes its instruction
      // snapshot on non-compact starts; Codex leaves native host instructions alone.
      if (cwd) {
        const dbPath = projectDbPath(cwd);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);

          if (isCodex) {
            const context = readCodexContext(
              db,
              session_id,
              source,
              config.restoration.recentSummaries,
              remainingContextBudget(codexContextParts, codexContextBudget),
            );
            if (context) codexContextParts.push(context);
          } else {
            const rows = db.prepare(
              `SELECT s.content FROM summaries s
               JOIN conversations c ON s.conversation_id = c.conversation_id
               WHERE c.session_id = ?
               ORDER BY s.depth DESC, s.created_at DESC
               LIMIT ?`,
            ).all(session_id, config.restoration.recentSummaries) as Array<{ content: string }>;

            if (rows.length > 0) {
              episodicContext = fenceContent(
                rows.map((r) => r.content).join("\n\n"),
                "recent-session-context",
              );
            }
          }

          // Promoted: cross-session knowledge from SQLite
          try {
            const promotedStore = new PromotedStore(db);
            const maxAgeDays = config.restoration.restoreMaxPromotedAgeDays;
            const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
            // Fetch more candidates than needed, then filter by age before capping.
            // This prevents old memories from consuming the top-5 slots and leaving
            // fewer results than available when newer memories exist.
            const results = promotedStore
              .search(`project context ${cwd}`, 20)
              .filter((r) => !r.createdAt || Date.parse(r.createdAt) >= cutoffMs)
              .slice(0, 5);
            if (results.length > 0) {
              if (isCodex) {
                const context = fitFencedText(
                  results.map((r) => r.content).join("\n\n"),
                  "project-knowledge",
                  remainingContextBudget(codexContextParts, codexContextBudget),
                );
                if (context) codexContextParts.push(context);
              } else {
                promotedContext = fenceContent(
                  results.map((r) => r.content).join("\n\n"),
                  "project-knowledge",
                );
              }
            }
          } catch { /* non-fatal */ }

          // Capture CLAUDE.md files and upsert into session_instructions if changed
          if (!isCodex) {
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
          }

        } catch { /* non-fatal */ } finally {
          closeLcmConnection(dbPath);
        }
      }

      // Query passive-capture insights from promoted store
      let insights: Array<{ content: string; confidence: number; tags: string[] }> = [];
      if (cwd) {
        try {
          const dbPath = projectDbPath(cwd);
          if (existsSync(dbPath)) {
            const insightsDb = getLcmConnection(dbPath);
            try {
              runLcmMigrations(insightsDb);
              const insightsStore = new PromotedStore(insightsDb);
              const thresholds = config.compaction.promotionThresholds;
              const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
              const maxAgeDays = thresholds.insightsMaxAgeDays ?? 90;
              const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
              insights = insightsStore
                .search("source passive capture", 10, ["source:passive-capture"])
                .filter((r) => r.confidence >= minConfidence && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
                .slice(0, 5)
                .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
            } finally {
              closeLcmConnection(dbPath);
            }
          }
        } catch { /* non-fatal */ }
      }

      // `instructionsContext` is deliberately omitted here. On startup/resume/clear the
      // host harness injects the applicable CLAUDE.md files itself, so echoing the
      // session_instructions snapshot back would duplicate them in context. The snapshot is
      // still captured above, and the isPostCompact branch still replays it — a compaction
      // is the only time the harness's own copy is gone.
      const context = isCodex
        ? codexContextParts.join("\n\n")
        : [orientation, episodicContext, promotedContext].filter(Boolean).join("\n\n");
      const responseBody: { context: string; insights?: Array<{ content: string; confidence: number; tags: string[] }> } = { context };
      if (insights.length > 0) {
        responseBody.insights = insights;
      }
      sendJson(res, 200, responseBody);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}
