import { WorkerStore } from "../../store/worker-store.js";
import { EventsDb, type EventRow, type PatternReinforcementStats } from "../../hooks/events-db.js";
import { eventsDbPath } from "../../db/events-path.js";
import { PromotedStore } from "../../db/promoted.js";
import { ToolLessonStore } from "../../promotion/tool-lessons.js";
import { passiveTypeTag } from "../../promotion/passive-tags.js";
import { deduplicateAndInsert } from "../../promotion/dedup.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";
import { projectId, projectDbPath } from "../project.js";
import { openProject } from "../project-group.js";
import { getLcmConnection, closeLcmConnection } from "../../db/connection.js";
import { runLcmMigrations } from "../../db/migration.js";
import type { DaemonConfig } from "../config.js";
import type { LcmPaths } from "../../lcm-paths.js";
import { safeLogError } from "../../hooks/hook-errors.js";
import { acquireProjectMutation, yieldToEventLoop } from "../project-queue.js";

const MIN_REINFORCED_PATTERN_OCCURRENCES = 3;
const MIN_REINFORCED_PATTERN_SESSIONS = 2;
const AUTO_PROMOTABLE_PATTERN_CATEGORIES = new Set(["file", "mcp", "skill", "subagent"]);
const EMPTY_REINFORCEMENT: PatternReinforcementStats = { totalCount: 0, distinctSessions: 0 };

interface PromoteResult {
  promoted: number;
  skipped: number;
  correlated: number;
  errors: number;
}

function isReinforcedPattern(stats: PatternReinforcementStats): boolean {
  return stats.totalCount >= MIN_REINFORCED_PATTERN_OCCURRENCES &&
    stats.distinctSessions >= MIN_REINFORCED_PATTERN_SESSIONS;
}

export function createPromoteEventsHandler(config: DaemonConfig, paths: LcmPaths): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");

    if (!input.cwd) {
      sendJson(res, 400, { error: "cwd is required" });
      return;
    }

    let cwd: string;
    try {
      cwd = validateCwd(input.cwd);
    } catch (err) {
      // Log the detailed error server-side and return a generic message to the client
      safeLogError("promote-events", err, { paths });
      sendJson(res, 400, { error: "cwd is invalid" });
      return;
    }

    const result: PromoteResult = { promoted: 0, skipped: 0, correlated: 0, errors: 0 };

    // Held across the loop's yields: a second run must not read the unprocessed events before this one marks them.
    const lease = await acquireProjectMutation(projectId(cwd));
    try {
      const sidecarPath = eventsDbPath(cwd, paths);
      const edb = new EventsDb(sidecarPath);

      try {
        const events = edb.getUnprocessed();
        // Open main project DB for promotion
        const pid = projectId(cwd);
        openProject(cwd, paths);
        const dbPath = projectDbPath(cwd, paths);
        const db = getLcmConnection(dbPath);
        try {
          runLcmMigrations(db);
          if (input.skip_tool_lessons !== true) result.correlated = await new ToolLessonStore(db).refresh(pid);
          if (events.length === 0) {
            sendJson(res, 200, { ...result, message: "no unprocessed events" });
            return;
          }
          const store = new PromotedStore(db);

          const thresholds = config.compaction.promotionThresholds;
          const eventConf = thresholds.eventConfidence ?? {
            decision: 0.5, plan: 0.7, errorFix: 0.4, batch: 0.3, pattern: 0.2,
          };
          const reinforcementCache = new Map<string, PatternReinforcementStats>();
          const getPatternReinforcement = (event: EventRow): PatternReinforcementStats => {
            if (event.priority !== 3 || !AUTO_PROMOTABLE_PATTERN_CATEGORIES.has(event.category)) {
              return EMPTY_REINFORCEMENT;
            }

            const key = `${event.type}\u0000${event.category}\u0000${event.data}`;
            const cached = reinforcementCache.get(key);
            if (cached) return cached;

            const stats = edb.getPatternReinforcement(
              event.type,
              event.category,
              event.data,
              thresholds.insightsMaxAgeDays ?? 90,
            );
            reinforcementCache.set(key, stats);
            return stats;
          };

          const processedIds: number[] = [];

          for (const event of events) {
            // Prompt intents are session metadata, never durable insights.
            if (event.category === "intent") { processedIds.push(event.event_id); result.skipped++; continue; }
            if (new WorkerStore(db).excluded(event.session_id)) { processedIds.push(event.event_id); result.skipped++; continue; }
            await yieldToEventLoop();
            try {
              const tag = passiveTypeTag(event.category);
              const reinforcement = getPatternReinforcement(event);
              const reinforced = isReinforcedPattern(reinforcement);
              let confidence: number;
              let newEntryConfidence: number | undefined;

              // Determine confidence by tier
              if (event.priority === 1) {
                // Tier 1: immediate
                if (event.category === "plan") {
                  confidence = eventConf.plan ?? 0.7;
                } else {
                  confidence = eventConf.decision ?? 0.5;
                }
              } else if (event.priority === 2) {
                // Tier 2: batch
                confidence = eventConf.batch ?? 0.3;
              } else {
                // Tier 3: pattern-only — require either an existing promoted match or
                // enough repeated passive evidence to bootstrap a new memory.
                confidence = eventConf.pattern ?? 0.2;
                if (!reinforced) {
                  const existing = store.search(event.data, 1, undefined, pid);
                  if (existing.length === 0) {
                    processedIds.push(event.event_id);
                    result.skipped++;
                    continue;
                  }
                } else {
                  newEntryConfidence = Math.min(
                    thresholds.maxConfidence ?? 1.0,
                    confidence + (thresholds.reinforcementBoost ?? 0.3),
                  );
                }
              }

              // Promote via existing dedup pipeline
              await deduplicateAndInsert({
                store,
                content: event.data,
                tags: [
                  tag,
                  "source:passive-capture",
                  `hook:${event.source_hook}`,
                  ...(reinforced ? ["signal:reinforced"] : []),
                ],
                projectId: pid,
                sessionId: event.session_id,
                depth: 0,
                confidence,
                newEntryConfidence,
                thresholds: {
                  dedupBm25Threshold: thresholds.dedupBm25Threshold ?? 15,
                  dedupCandidateLimit: thresholds.dedupCandidateLimit ?? 100,
                },
              });

              processedIds.push(event.event_id);
              result.promoted++;
            } catch (error) {
              result.errors++;
              safeLogError("promote-events", error, { cwd, sessionId: event.session_id, paths });
              // Do not add to processedIds — transient errors (DB busy, dedup failure) should
              // allow the event to be retried on next promotion pass rather than being silently dropped.
            }
          }

          edb.markProcessed(processedIds);
        } finally {
          closeLcmConnection(dbPath);
        }
      } finally {
        edb.close();
      }
    } catch (error) {
      // Log detailed failure but avoid exposing internal error/stack info to the client
      safeLogError("promote-events", error, { cwd, paths });
      sendJson(res, 500, { error: "failed to promote events" });
      return;
    } finally {
      lease.release();
    }

    sendJson(res, 200, result);
  };
}
