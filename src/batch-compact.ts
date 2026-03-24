import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "./db/migration.js";

export interface UncompactedConversation {
  projectDir: string;
  cwd: string;
  conversationId: number;
  sessionId: string;
  messages: number;
  tokens: number;
}

/** Find conversations eligible for compaction, above the token threshold. */
export function findUncompacted(minTokens: number, readOnly = false, cwdFilter?: string, replay = false): UncompactedConversation[] {
  const baseDir = join(homedir(), ".lossless-claude", "projects");
  if (!existsSync(baseDir)) return [];

  const results: UncompactedConversation[] = [];

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projDir = join(baseDir, entry.name);
    const dbPath = join(projDir, "db.sqlite");
    if (!existsSync(dbPath)) continue;

    const metaPath = join(projDir, "meta.json");
    let cwd = "";
    if (existsSync(metaPath)) {
      try {
        cwd = JSON.parse(readFileSync(metaPath, "utf-8")).cwd ?? "";
      } catch { /* skip corrupt meta */ }
    }
    if (!cwd) continue;
    if (cwdFilter && cwd !== cwdFilter) continue;

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      if (!readOnly) runLcmMigrations(db);
      const rows = db.prepare(`
        SELECT
          c.conversation_id,
          c.session_id,
          COALESCE(m.msg_count, 0) as messages,
          COALESCE(m.raw_tokens, 0) as tokens,
          COALESCE(s.sum_count, 0) as summaries
        FROM conversations c
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as msg_count, SUM(token_count) as raw_tokens
          FROM messages GROUP BY conversation_id
        ) m ON m.conversation_id = c.conversation_id
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as sum_count
          FROM summaries GROUP BY conversation_id
        ) s ON s.conversation_id = c.conversation_id
        WHERE COALESCE(m.msg_count, 0) > 0
          AND (? OR COALESCE(s.sum_count, 0) = 0)
          AND COALESCE(m.raw_tokens, 0) >= ?
        ORDER BY COALESCE(m.raw_tokens, 0) DESC
      `).all(replay ? 1 : 0, minTokens) as { conversation_id: number; session_id: string; messages: number; tokens: number; summaries: number }[];

      for (const row of rows) {
        results.push({
          projectDir: projDir,
          cwd,
          conversationId: row.conversation_id,
          sessionId: row.session_id,
          messages: row.messages,
          tokens: row.tokens,
        });
      }
    } catch { /* skip corrupt databases */ }
    finally { db.close(); }
  }

  return results;
}

/** Compact all uncompacted conversations above threshold via the daemon. */
export async function batchCompact(opts: {
  minTokens: number;
  dryRun: boolean;
  port: number;
  cwd?: string;
  replay?: boolean;
}): Promise<{ compacted: number }> {
  const conversations = findUncompacted(opts.minTokens, opts.dryRun, opts.cwd, opts.replay);

  if (conversations.length === 0) {
    console.log("Nothing to compact — all sessions are up to date.");
    return { compacted: 0 };
  }

  const totalTokens = conversations.reduce((s, c) => s + c.tokens, 0);
  console.log(`Found ${conversations.length} uncompacted conversation${conversations.length > 1 ? "s" : ""} (${(totalTokens / 1000).toFixed(1)}k tokens)\n`);

  let compacted = 0;

  for (const conv of conversations) {
    const label = `${conv.cwd} conv #${conv.conversationId} (${conv.messages} msgs, ${(conv.tokens / 1000).toFixed(1)}k tokens)`;

    if (opts.dryRun) {
      console.log(`  [dry-run] would compact: ${label}`);
      continue;
    }

    process.stdout.write(`  compacting: ${label}...`);
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: conv.sessionId,
          cwd: conv.cwd,
          skip_ingest: true,
          client: "claude",
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.log(` FAILED (HTTP ${res.status}${body ? `: ${body}` : ""})`);
      } else {
        const data = await res.json() as { summary?: string; skipped?: boolean };
        if (data.skipped) {
          console.log(" skipped (already in progress)");
        } else {
          console.log(" done");
          compacted++;
        }
      }
    } catch (err) {
      console.log(` FAILED (${err instanceof Error ? err.message : "unknown error"})`);
    }
  }

  if (!opts.dryRun) {
    console.log("\nBatch compact complete.");
  }

  return { compacted };
}
