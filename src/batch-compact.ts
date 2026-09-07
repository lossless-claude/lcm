import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "./db/migration.js";
import type { ProgressState } from "./cli/progress-state.js";
import { DaemonClient } from "./daemon/client.js";
import {
  clearReplayState,
  createReplayRun,
  fingerprintStats,
  planReplayResume,
  recordReplayProgress,
} from "./replay-resume.js";

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
  /** Replay only: discard recorded progress and start from scratch */
  restart?: boolean;
  verbose?: boolean;
  tokenPath?: string;
  /** Replay only: model label recorded in the ledger (shown on resume) */
  replayModel?: string;
  /** Called with state patches as each session is processed — used by the ninja renderer */
  onProgress?: (patch: Partial<ProgressState>) => void;
  /** Called before each conversation starts; return false to stop the run (e.g. after SIGINT/SIGTERM) */
  onBeforeSession?: () => boolean;
  /** Wrap an in-flight conversation's work so signal handlers can wait for it before exiting */
  trackInFlight?: () => () => void;
}): Promise<{ compacted: number }> {
  let conversations = findUncompacted(opts.minTokens, opts.dryRun, opts.cwd, opts.replay);
  const onProgress = opts.onProgress;

  // Replay runs are resumable: a per-project manifest freezes the ordering and
  // a ledger records completed compactions, so a restarted run skips finished work.
  let replayRuns: Map<string, { runId: string; positions: Map<string, number> }> | null = null;
  let skippedDone = 0;
  if (opts.replay && !opts.dryRun && conversations.length > 0) {
    replayRuns = new Map();
    if (opts.restart) {
      let clearFailed = false;
      for (const cwd of new Set(conversations.map((c) => c.cwd))) {
        if (!clearReplayState({ cwd, command: "compact" })) clearFailed = true;
      }
      if (clearFailed) {
        console.error("  ⚠️ [replay] could not fully clear previous replay state; some stale summaries may remain");
      }
    }
    const plan = planReplayResume({
      sessions: conversations,
      command: "compact",
      fingerprint: (c) => fingerprintStats(c.messages, c.tokens),
      restart: opts.restart,
    });
    for (const [cwd, order] of plan.manifests) {
      const positions = new Map<string, number>();
      if (plan.freshCwds.has(cwd)) {
        createReplayRun({
          cwd,
          command: "compact",
          runId: plan.runIds.get(cwd)!,
          sessions: order.map((sessionId) => ({ sessionId })),
          model: opts.replayModel ?? null,
        });
        order.forEach((sid, i) => positions.set(sid, i));
      } else {
        positions.clear();
        for (const [sid, pos] of plan.positions.get(cwd) ?? []) positions.set(sid, pos);
      }
      replayRuns.set(cwd, { runId: plan.runIds.get(cwd)!, positions });
    }
    skippedDone = plan.doneCount;
    conversations = plan.remaining;
    if (plan.doneCount > 0) {
      onProgress?.({
        resumed: { doneCount: plan.doneCount, totalCount: plan.doneCount + plan.remaining.length, model: plan.previousModel ?? undefined },
      });
    }
    for (const changed of plan.changedSessionIds) {
      console.error(`  ⚠️ [replay] conversation for session ${changed} changed since the previous run; downstream summaries were built on the older version`);
    }
  }

  if (conversations.length === 0) {
    console.log("Nothing to compact — all sessions are up to date.");
    return { compacted: 0 };
  }

  const totalTokens = conversations.reduce((s, c) => s + c.tokens, 0);
  console.log(`Found ${conversations.length} uncompacted conversation${conversations.length > 1 ? "s" : ""} (${(totalTokens / 1000).toFixed(1)}k tokens)\n`);

  // Notify renderer of total so it can show accurate progress
  onProgress?.({ total: conversations.length + skippedDone });

  let compacted = 0;
  let doneCount = skippedDone;
  let messagesIn = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const progressErrors: { sessionId: string; message: string }[] = [];
  const client = new DaemonClient(`http://127.0.0.1:${opts.port}`, opts.tokenPath);

  for (const conv of conversations) {
    // Stop starting new work after SIGINT/SIGTERM; the renderer waits for the
    // in-flight compaction to settle before exiting.
    if (opts.onBeforeSession && !opts.onBeforeSession()) break;

    const label = `${conv.cwd} conv #${conv.conversationId} (${conv.messages} msgs, ${(conv.tokens / 1000).toFixed(1)}k tokens)`;

    if (opts.dryRun) {
      console.log(`  [dry-run] would compact: ${label}`);
      doneCount++;
      onProgress?.({ completed: doneCount });
      continue;
    }

    const sessionStart = Date.now();
    onProgress?.({ current: { sessionId: conv.sessionId, messages: conv.messages, tokens: conv.tokens, startedAt: sessionStart } });
    process.stdout.write(`  compacting: ${label}...`);
    const releaseInFlight = opts.trackInFlight ? opts.trackInFlight() : null;
    try {
      const data = await client.post<{ summary?: string; skipped?: boolean; tokensBefore?: number; tokensAfter?: number; providerLabel?: string; latestSummaryId?: string }>("/compact", {
        session_id: conv.sessionId,
        cwd: conv.cwd,
        skip_ingest: true,
        client: "claude",
      });

      // Ledger row is written only after the summary is persisted
      // (latestSummaryId in hand), so a row is durable proof of done work.
      // A skipped (already-in-progress) compaction records nothing — the next
      // run retries it.
      const run = replayRuns?.get(conv.cwd);
      if (run && data.skipped !== true) {
        recordReplayProgress({
          cwd: conv.cwd,
          runId: run.runId,
          sessionId: conv.sessionId,
          position: run.positions.get(conv.sessionId) ?? 0,
          prevSessionId: null,
          contentFingerprint: fingerprintStats(conv.messages, conv.tokens),
          summaryId: data.latestSummaryId ?? null,
          model: opts.replayModel ?? null,
        });
      }

      doneCount++;
      if (data.skipped) {
        console.log(" skipped (already in progress)");
        onProgress?.({
          completed: doneCount,
          current: undefined,
          lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
        });
      } else {
        const before = typeof data.tokensBefore === "number" ? data.tokensBefore : 0;
        const after = typeof data.tokensAfter === "number" ? data.tokensAfter : 0;
        tokensIn += before;
        tokensOut += after;
        if (opts.verbose && before > 0) {
          const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
          console.log(` done  (${(before / 1000).toFixed(1)}k → ${(after / 1000).toFixed(1)}k tokens, ${pct}% reduction)`);
        } else {
          console.log(" done");
        }
        compacted++;
        messagesIn += conv.messages;
        tokensIn += data.tokensBefore ?? conv.tokens;
        tokensOut += data.tokensAfter ?? 0;
        onProgress?.({
          completed: doneCount,
          messagesIn,
          tokensIn,
          tokensOut,
          current: undefined,
          lastResult: {
            sessionId: conv.sessionId,
            messages: conv.messages,
            tokensBefore: data.tokensBefore ?? conv.tokens,
            tokensAfter: data.tokensAfter,
            provider: data.providerLabel,
            elapsed: Date.now() - sessionStart,
          },
        });
      }
    } catch (err) {
      doneCount++;
      const errMsg = err instanceof Error ? err.message : "unknown error";
      console.log(` FAILED (${errMsg})`);
      progressErrors.push({ sessionId: conv.sessionId, message: errMsg });
      onProgress?.({
        completed: doneCount,
        current: undefined,
        errors: progressErrors,
        lastResult: { sessionId: conv.sessionId, messages: conv.messages, tokensBefore: conv.tokens, elapsed: Date.now() - sessionStart },
      });
    } finally {
      releaseInFlight?.();
    }
  }

  if (!opts.dryRun) {
    if (tokensIn > 0) {
      const freed = tokensIn - tokensOut;
      const pct = Math.round((freed / tokensIn) * 100);
      console.log(`\nBatch compact complete. ${compacted} session${compacted !== 1 ? "s" : ""} compacted, ${(tokensIn / 1000).toFixed(1)}k → ${(tokensOut / 1000).toFixed(1)}k tokens (${pct}% reduction, ${(freed / 1000).toFixed(1)}k freed)`);
    } else {
      console.log("\nBatch compact complete.");
    }
  }

  return { compacted };
}
