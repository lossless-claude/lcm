import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectId, projectDbPath, projectMetaPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { PromotedStore } from "../../db/promoted.js";
import { shouldPromote } from "../../promotion/detector.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import type { LcmSummarizeFn } from "../../llm/types.js";

export function createPromoteHandler(
  config: DaemonConfig,
  getSummarizer: () => Promise<LcmSummarizeFn | null>,
): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { cwd, dry_run = false } = input;

    if (!cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { processed: 0, promoted: 0 });
      return;
    }

    const summarize = await getSummarizer();

    const db = new DatabaseSync(dbPath);
    let processed = 0;
    let promoted = 0;

    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      mkdirSync(dirname(dbPath), { recursive: true });

      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const pid = projectId(cwd);

      const conversations = await convStore.listConversations();

      for (const conversation of conversations) {
        const summaries = await summStore.getSummariesByConversation(conversation.conversationId);

        for (const summary of summaries) {
          processed++;

          const promotionResult = shouldPromote(
            {
              content: summary.content,
              depth: summary.depth,
              tokenCount: summary.tokenCount,
              sourceMessageTokenCount: summary.sourceMessageTokenCount,
            },
            config.compaction.promotionThresholds,
          );

          if (!promotionResult.promote) continue;

          if (dry_run) {
            promoted++; // dry_run: count but don't insert
          } else if (summarize) {
            const promotedStore = new PromotedStore(db);
            try {
              await deduplicateAndInsert({
                store: promotedStore,
                content: summary.content,
                tags: promotionResult.tags,
                projectId: pid,
                sessionId: conversation.sessionId,
                depth: summary.depth,
                confidence: promotionResult.confidence,
                summarize,
                thresholds: {
                  dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                  mergeMaxEntries: config.compaction.promotionThresholds.mergeMaxEntries,
                  confidenceDecayRate: config.compaction.promotionThresholds.confidenceDecayRate,
                },
              });
              promoted++;
            } catch { /* non-fatal — don't count failed promotions */ }
          }
          // If summarize is null (disabled provider), skip — can't promote without a summarizer
        }
      }

      // Update meta.json unless dry_run
      if (!dry_run) {
        try {
          const metaPath = projectMetaPath(cwd);
          let meta: Record<string, unknown> = {};
          if (existsSync(metaPath)) {
            meta = JSON.parse(readFileSync(metaPath, "utf-8"));
          }
          meta.cwd = cwd;
          meta.lastPromote = new Date().toISOString();
          writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        } catch { /* non-fatal */ }
      }
    } finally {
      db.close();
    }

    sendJson(res, 200, { processed, promoted });
  };
}
