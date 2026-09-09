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
function wasJustCompacted(cwd: string | undefined, sessionId: unknown): boolean {
  // `/compact` writes the mark under a string session id, so nothing else can match one.
  if (!cwd || typeof sessionId !== "string" || !sessionId) return false;
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

  // A tool log labelled "User" would tell the model the user said it, which
  // is the confusion the role tag exists to end.
  const speaker = (role: string | null) =>
    role === "assistant" ? "Assistant" : role === "tool" ? "Tool" : "User";
  const items = rows.map((row) => row.item_type === "summary"
    ? `Summary:\n${row.content}`
    : `${speaker(row.role)}:\n${row.content}`);
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

/** A passive-capture insight, as the response carries it. */
type Insight = { content: string; confidence: number; tags: string[] };

/** What either client's builder reads from the request. */
type RestoreRequest = {
  sessionId: unknown;
  source: unknown;
  cwd?: string;
  orientation: string;
};

/** A built restore: the context to return, and whether insights ride along with it. */
type RestoreContext = { context: string; includeInsights: boolean };

/** The project's promoted memories, recent enough to still be worth restoring. */
function readPromotedMemories(db: DatabaseSync, cwd: string, config: DaemonConfig): string[] {
  try {
    const cutoffMs = Date.now() - config.restoration.restoreMaxPromotedAgeDays * 24 * 60 * 60 * 1000;
    // Fetch more candidates than needed, then filter by age before capping: otherwise old
    // memories consume the five slots while newer ones exist.
    return new PromotedStore(db)
      .search(`project context ${cwd}`, 20)
      .filter((r) => !r.createdAt || Date.parse(r.createdAt) >= cutoffMs)
      .slice(0, 5)
      .map((r) => r.content);
  } catch {
    return []; // Non-fatal: a restore without promoted memory is still a restore.
  }
}

/** Fences the parts under one tag, or answers empty when there is nothing to fence. */
function fenceOrEmpty(parts: string[], tag: string): string {
  return parts.length > 0 ? fenceContent(parts.join("\n\n"), tag) : "";
}

/** The snapshot a post-compaction restore replays: the CLAUDE.md files as they were. */
function readInstructionsSnapshot(cwd: string | undefined): string {
  if (!cwd) return "";
  const dbPath = projectDbPath(cwd);
  if (!existsSync(dbPath)) return "";
  try {
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      const row = db
        .prepare(`SELECT content, content_hash, updated_at FROM session_instructions WHERE id = 1`)
        .get() as SessionInstructionsRow | undefined;
      return row ? `<project-instructions>\n${row.content}\n</project-instructions>` : "";
    } finally {
      closeLcmConnection(dbPath);
    }
  } catch {
    return ""; // Non-fatal: without a snapshot the restore is thinner, not broken.
  }
}

/** Keeps the snapshot current, so the next compaction has something to replay. */
function refreshInstructionsSnapshot(db: DatabaseSync, cwd: string): void {
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

/** The session's own recent summaries, deepest first. */
function readEpisodicContext(db: DatabaseSync, sessionId: unknown, limit: number): string {
  // A non-string session id matches no conversation, and binding one throws — which would
  // take the promoted memory and the snapshot refresh down with it, silently.
  if (typeof sessionId !== "string" || !sessionId) return "";
  const rows = db.prepare(
    `SELECT s.content FROM summaries s
     JOIN conversations c ON s.conversation_id = c.conversation_id
     WHERE c.session_id = ?
     ORDER BY s.depth DESC, s.created_at DESC
     LIMIT ?`,
  ).all(sessionId, limit) as Array<{ content: string }>;
  if (rows.length === 0) return "";
  return fenceContent(rows.map((r) => r.content).join("\n\n"), "recent-session-context");
}

/**
 * Claude's restore.
 *
 * After a compaction it replays the saved CLAUDE.md snapshot and nothing else: that is the
 * one moment the harness's own copy is gone. Every other start returns the session's
 * episodic memory and the project's promoted knowledge, and refreshes the snapshot for the
 * next compaction without returning it — the harness injects those files itself, so echoing
 * them back would duplicate them.
 */
function buildClaudeRestore(config: DaemonConfig, req: RestoreRequest): RestoreContext {
  // `source` is absent whenever the function-hooks module asks: prompt.context carries no
  // reason for firing, so there the mark `/compact` left is the only thing that
  // distinguishes a post-compaction restore from a fresh one.
  const isExplicitNonCompact =
    req.source === "startup" || req.source === "resume" || req.source === "clear";
  const isPostCompact = req.source === "compact"
    || (!isExplicitNonCompact && wasJustCompacted(req.cwd, req.sessionId));

  if (isPostCompact) {
    const parts = [req.orientation, readInstructionsSnapshot(req.cwd)];
    return { context: parts.filter(Boolean).join("\n\n"), includeInsights: false };
  }

  let episodic = "";
  let promoted = "";
  if (req.cwd) {
    const dbPath = projectDbPath(req.cwd);
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      episodic = readEpisodicContext(db, req.sessionId, config.restoration.recentSummaries);
      promoted = fenceOrEmpty(readPromotedMemories(db, req.cwd, config), "project-knowledge");
      refreshInstructionsSnapshot(db, req.cwd);
    } catch { /* Non-fatal: return whatever was gathered before the failure. */ } finally {
      closeLcmConnection(dbPath);
    }
  }

  return {
    context: [req.orientation, episodic, promoted].filter(Boolean).join("\n\n"),
    includeInsights: true,
  };
}

/**
 * Codex's restore.
 *
 * The native host keeps its own instructions, so nothing here reads or writes the CLAUDE.md
 * snapshot, and the compaction mark is never consulted. What it returns is the conversation's
 * recent context and the project's promoted knowledge, each trimmed to what is left of the
 * injection budget.
 */
function buildCodexRestore(config: DaemonConfig, req: RestoreRequest): RestoreContext {
  const parts = req.orientation ? [req.orientation] : [];
  const answer = () => ({ context: parts.join("\n\n"), includeInsights: true as const });
  if (!req.cwd) return answer();

  const budget = config.restoration.maxInjectedMemoryBytes;
  const dbPath = projectDbPath(req.cwd);
  const db = getLcmConnection(dbPath);
  try {
    runLcmMigrations(db);
    const recent = readCodexContext(
      db, req.sessionId, req.source,
      config.restoration.recentSummaries,
      remainingContextBudget(parts, budget),
    );
    if (recent) parts.push(recent);

    const knowledge = fitFencedText(
      readPromotedMemories(db, req.cwd, config).join("\n\n"),
      "project-knowledge",
      remainingContextBudget(parts, budget),
    );
    if (knowledge) parts.push(knowledge);
  } catch { /* Non-fatal: return whatever was gathered before the failure. */ } finally {
    closeLcmConnection(dbPath);
  }

  return answer();
}

/** Passive-capture insights, which both clients receive alongside their context. */
function readInsights(config: DaemonConfig, cwd: string | undefined): Insight[] {
  if (!cwd) return [];
  const dbPath = projectDbPath(cwd);
  if (!existsSync(dbPath)) return [];
  try {
    const db = getLcmConnection(dbPath);
    try {
      runLcmMigrations(db);
      const thresholds = config.compaction.promotionThresholds;
      const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
      const cutoffMs = Date.now() - (thresholds.insightsMaxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
      return new PromotedStore(db)
        .search("source passive capture", 10, ["source:passive-capture"])
        .filter((r) => r.confidence >= minConfidence
          && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
        .slice(0, 5)
        .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
    } finally {
      closeLcmConnection(dbPath);
    }
  } catch {
    return []; // Non-fatal: insights are an extra, not the restore.
  }
}

/**
 * POST /restore — the session's memory, assembled the way its client wants it.
 *
 * Claude and Codex do not share an assembly: they read different tables, render different
 * blocks and answer with different bodies. The route validates the request and hands it to
 * one builder or the other; neither knows the other exists.
 */
export function createRestoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    try {
      const input = JSON.parse(body || "{}");
      let cwd: string | undefined;
      if (input.cwd) {
        try {
          cwd = validateCwd(input.cwd);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
          return;
        }
      }

      const request: RestoreRequest = {
        sessionId: input.session_id,
        source: input.source,
        cwd,
        orientation: buildOrientationPrompt(),
      };
      const built = input.client === "codex"
        ? buildCodexRestore(config, request)
        : buildClaudeRestore(config, request);

      const responseBody: { context: string; insights?: Insight[] } = { context: built.context };
      if (built.includeInsights) {
        const insights = readInsights(config, cwd);
        if (insights.length > 0) responseBody.insights = insights;
      }
      sendJson(res, 200, responseBody);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "restore failed" });
    }
  };
}
