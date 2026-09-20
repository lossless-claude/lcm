import type { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { PromotedStore } from "../../db/promoted.js";

/**
 * Passive-capture insights: promoted memories the capture path recorded on its own, which
 * ride along with a restore's context rather than inside it.
 */
export interface Insight {
  content: string;
  confidence: number;
  tags: string[];
}

/** The insights a restore offers: the newest confident ones, capped and age-filtered. */
export function readInsights(db: DatabaseSync, config: DaemonConfig): Insight[] {
  const thresholds = config.compaction.promotionThresholds;
  const minConfidence = thresholds.eventConfidence?.pattern ?? 0.3;
  const cutoffMs = Date.now() - (thresholds.insightsMaxAgeDays ?? 90) * 24 * 60 * 60 * 1000;
  return new PromotedStore(db)
    .search("source passive capture", 10, ["source:passive-capture"])
    .filter((r) => r.confidence >= minConfidence
      && (!r.createdAt || Date.parse(r.createdAt) >= cutoffMs))
    .slice(0, 5)
    .map((r) => ({ content: r.content, confidence: r.confidence, tags: r.tags }));
}