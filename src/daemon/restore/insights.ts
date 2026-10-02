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
  // Only environment rules ride along, as one short line each. Error→fix pairs and block
  // reasons carry whole commands; they stay in the store until shadow measurement (#772)
  // shows that showing them prevents repeats.
  const lessons = new ToolLessonStore(db).list({ kind: "environment-rule", limit: SESSION_START_RULES })
    .filter(lesson => Date.parse(lesson.lastSeen) >= cutoffMs)
    .map(lessonInsight);
  return [...lessons, ...passive].slice(0, 5);
}

/** Environment rules shown at session start. */
const SESSION_START_RULES = 3;
/** A rule line names a command shape, never a command. */
const RULE_SHAPE_MAX_CHARS = 120;

function lessonInsight(lesson: ToolLesson): Insight {
  const sessionCount = Object.keys(lesson.sessionCounts).length;
  const fullShape = lesson.shape ?? "";
  const shape = fullShape.length > RULE_SHAPE_MAX_CHARS ? `${fullShape.slice(0, RULE_SHAPE_MAX_CHARS)}…` : fullShape;
  const content = `Environment rule: \`${shape}\` failed or was blocked in ${sessionCount} sessions, with no success since (last ${lesson.lastSeen.slice(0, 10)}).`;
  return { content, tags: lesson.tags,
    count: lesson.count, sessionCount, firstSeen: lesson.firstSeen, lastSeen: lesson.lastSeen };
}
