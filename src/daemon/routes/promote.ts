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
import { validateCwd } from "../validate-cwd.js";

export function createPromoteHandler(
  config: DaemonConfig,
): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { dry_run = false } = input;

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid cwd" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { processed: 0, promoted: 0 });
      return;
    }

    const db = new DatabaseSync(dbPath);
    let processed = 0;
    let promoted = 0;
    let totalConversations = 0;

    try {
      db.exec("PRAGMA busy_timeout = 5000");
      runLcmMigrations(db);
      mkdirSync(dirname(dbPath), { recursive: true });

      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const pid = projectId(cwd);

      // Get summary IDs that have already been promoted (to avoid re-promoting)
      const promotedStore = new PromotedStore(db);
      const alreadyPromotedContent = new Set(
        promotedStore.listContentPrefixes(10000).map((c) => c.slice(0, 100)),
      );

      const conversations = await convStore.listConversations();
      totalConversations = conversations.length;

      for (const conversation of conversations) {
        const summaries = await summStore.getSummariesByConversation(conversation.conversationId);

        for (const summary of summaries) {
          // Skip summaries whose content prefix is already in the promoted store
          // This prevents re-promoting on repeated runs (which would decay confidence)
          if (alreadyPromotedContent.has(summary.content.slice(0, 100))) continue;

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
            promoted++;
          } else {
            try {
              await deduplicateAndInsert({
                store: promotedStore,
                content: summary.content,
                tags: promotionResult.tags,
                projectId: pid,
                sessionId: conversation.sessionId,
                depth: summary.depth,
                confidence: promotionResult.confidence,
                thresholds: {
                  dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                  dedupCandidateLimit: config.compaction.promotionThresholds.dedupCandidateLimit,
                },
              });
              promoted++;
            } catch { /* non-fatal — don't count failed promotions */ }
          }
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
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "promote failed" });
      return;
    } finally {
      db.close();
    }

    sendJson(res, 200, { processed, promoted, conversations: totalConversations });
  };
}
