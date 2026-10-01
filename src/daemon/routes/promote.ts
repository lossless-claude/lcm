import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { projectId, projectDbPath } from "../project.js";
import { updateProjectMeta } from "../project-meta.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { PromotedStore } from "../../db/promoted.js";
import { shouldPromote } from "../../promotion/detector.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { validateCwd } from "../validate-cwd.js";
import { noopDaemonLog, type DaemonLog } from "../log.js";
import { acquireProjectMutation, yieldToEventLoop } from "../project-queue.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";

export function createPromoteHandler(
  config: DaemonConfig,
  paths: LcmPaths,
  log: DaemonLog = noopDaemonLog,
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

    const dbPath = projectDbPath(cwd, paths);
    if (!existsSync(dbPath)) {
      sendJson(res, 200, { processed: 0, promoted: 0 });
      return;
    }

    // Held across the loop's yields: a second run must not read the promoted set before this one writes it.
    const lease = await acquireProjectMutation(projectId(cwd));
    let db: DatabaseSync | undefined;
    let processed = 0;
    let promoted = 0;
    let totalConversations = 0;

    try {
      db = getLcmConnection(dbPath);
      runLcmMigrations(db);
      mkdirSync(dirname(dbPath), { recursive: true });

      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const pid = projectId(cwd);

      // Get summary IDs that have already been promoted (to avoid re-promoting)
      const promotedStore = new PromotedStore(db);
      const alreadyPromotedSummaryIds = new Set(promotedStore.listSourceSummaryIds());
      const legacyContentPrefixes = new Set(promotedStore.listLegacyContentPrefixes());

      const conversations = await convStore.listConversations();
      totalConversations = conversations.length;

      for (const conversation of conversations) {
        await yieldToEventLoop();
        const summaries = await summStore.getSummariesByConversation(conversation.conversationId);

        for (const summary of summaries) {
          // Skip recorded summary IDs (including archived inputs) or legacy content prefixes.
          // This prevents re-promoting on repeated runs (which would decay confidence)
          if (alreadyPromotedSummaryIds.has(summary.summaryId)
            || legacyContentPrefixes.has(summary.content.slice(0, 100))) continue;

          processed++;
          await yieldToEventLoop();

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
                sourceSummaryId: summary.summaryId,
                depth: summary.depth,
                confidence: promotionResult.confidence,
                thresholds: {
                  dedupBm25Threshold: config.compaction.promotionThresholds.dedupBm25Threshold,
                  dedupCandidateLimit: config.compaction.promotionThresholds.dedupCandidateLimit,
                },
              });
              promoted++;
            } catch (err) {
              log.write("warn", "promote.insert_failed", { cwd, err }); // not counted as promoted
            }
          }
        }
      }

      if (!dry_run) {
        try {
          updateProjectMeta(cwd, paths, { lastPromote: new Date().toISOString() });
        } catch (err) {
          log.write("warn", "promote.meta_failed", { cwd, err });
        }
      }
    } catch (err) {
      log.write("error", "promote.failed", { cwd, err });
      sendJson(res, 500, { error: err instanceof Error ? err.message : "promote failed" });
      return;
    } finally {
      if (db) closeLcmConnection(dbPath);
      lease.release();
    }

    log.write("info", "promote.done", { cwd, processed, promoted, dry_run });
    sendJson(res, 200, { processed, promoted, conversations: totalConversations });
  };
}
