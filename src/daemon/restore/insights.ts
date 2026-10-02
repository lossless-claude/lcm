import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { ToolLessonStore, type ToolLesson } from "../../promotion/tool-lessons.js";
import { PromotedStore } from "../../db/promoted.js";

/**
 * Passive-capture insights: promoted memories the capture path recorded on its own, which
 * ride along with a restore's context rather than inside it.
 */
export interface Insight {
  content: string;
  confidence?: number;
  count?: number;
  sessionCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  tags: string[];
}

/** The insights a restore offers: the newest confident ones, capped and age-filtered. */
export function readInsights(db: DatabaseSync, config: DaemonConfig): Insight[] {
  const thresholds = config.compaction.promotionThresholds;
  const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
  const cutoffMs = Date.now() - (thresholds.insightsMaxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  const passive = new PromotedStore(db)
    .search("source passive capture", 10, ["source:passive-capture"])
    .filter((r) => r.confidence >= minConfidence
      && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
    .slice(0, 5)
    .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
  const lessons = new ToolLessonStore(db).list({ limit: 5 })
    .filter(lesson => Date.parse(lesson.lastSeen) >= cutoffMs)
    .map(lessonInsight);
  return [...lessons, ...passive].slice(0, 5);
}

function lessonInsight(lesson: ToolLesson): Insight {
  const sessionCount = Object.keys(lesson.sessionCounts).length;
  const evidence = `${lesson.count} occurrence(s) in ${sessionCount} session(s); first seen ${lesson.firstSeen}; last seen ${lesson.lastSeen}`;
  let content: string;
  if (lesson.kind === "error-fix") content = `Observed failure→success for ${lesson.shape}: "${lesson.failedCommand}" → "${lesson.succeededCommand}".`;
  else if (lesson.kind === "block-reason") content = `Observed block reason: ${lesson.reason}.`;
  else content = `Environment rule: ${lesson.shape} failed or was blocked across sessions, with no observed success since its first failure.`;
  return { content: `${content} ${evidence}`, tags: lesson.tags,
    count: lesson.count, sessionCount, firstSeen: lesson.firstSeen, lastSeen: lesson.lastSeen };
}
