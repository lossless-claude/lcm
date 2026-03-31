import type { DatabaseSync } from "node:sqlite";

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export interface RecallStats {
  memoriesSurfaced: number;
  memoriesActedUpon: number;
  recallPrecision: number | null;
  topRecalled: Array<{ id: string; content: string; actCount: number }>;
}

export interface RecallFeedback {
  usageCount: number;
  surfacingCount: number;
  lastSurfacedAt: string | null;
}

export class RecallStore {
  constructor(private db: DatabaseSync) {}

  /** Log that a set of memory IDs were surfaced to an agent in a user-prompt context. */
  logSurfacing(memoryIds: string[], sessionId: string | null): void {
    if (memoryIds.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO recall_surfacing (memory_id, session_id) VALUES (?, ?)`
    );
    for (const id of memoryIds) {
      stmt.run(id, sessionId ?? null);
    }
  }

  getFeedback(memoryIds: string[]): Map<string, RecallFeedback> {
    const feedback = new Map<string, RecallFeedback>();
    for (const id of memoryIds) {
      feedback.set(id, {
        usageCount: 0,
        surfacingCount: 0,
        lastSurfacedAt: null,
      });
    }

    if (memoryIds.length === 0) return feedback;

    const placeholders = memoryIds.map(() => "?").join(", ");
    const surfacingRows = this.db.prepare(
      `SELECT memory_id, COUNT(*) as surfacing_count, MAX(surfaced_at) as last_surfaced_at
       FROM recall_surfacing
       WHERE memory_id IN (${placeholders})
       GROUP BY memory_id`
    ).all(...memoryIds) as Array<{
      memory_id: string;
      surfacing_count: number;
      last_surfaced_at: string | null;
    }>;

    for (const row of surfacingRows) {
      feedback.set(row.memory_id, {
        usageCount: feedback.get(row.memory_id)?.usageCount ?? 0,
        surfacingCount: row.surfacing_count,
        lastSurfacedAt: row.last_surfaced_at,
      });
    }

    for (const [memoryId, usageCount] of this.collectUsageCounts(memoryIds)) {
      const current = feedback.get(memoryId);
      if (!current) continue;
      feedback.set(memoryId, {
        ...current,
        usageCount,
      });
    }

    return feedback;
  }

  getStats(): RecallStats {
    // Distinct memories that have ever been surfaced
    const surfacedRow = this.db.prepare(
      `SELECT COUNT(DISTINCT memory_id) as count FROM recall_surfacing`
    ).get() as { count: number };
    const memoriesSurfaced = surfacedRow.count;

    // Find all signal:memory_used entries in promoted, extract the referenced memory_id:<uuid> tag
    const memoryIdCounts = this.collectUsageCounts();

    const memoriesActedUpon = memoryIdCounts.size;
    const recallPrecision =
      memoriesSurfaced > 0
        ? Math.min(100, (memoriesActedUpon / memoriesSurfaced) * 100)
        : null;

    // Top 5 most-acted-upon memories by act count
    const sorted = [...memoryIdCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const topRecalled: Array<{ id: string; content: string; actCount: number }> = [];
    for (const [memId, count] of sorted) {
      const memRow = this.db.prepare(
        `SELECT content FROM promoted WHERE id = ?`
      ).get(memId) as { content: string } | undefined;
      topRecalled.push({
        id: memId,
        content: memRow?.content ?? "(memory not found)",
        actCount: count,
      });
    }

    return { memoriesSurfaced, memoriesActedUpon, recallPrecision, topRecalled };
  }

  private collectUsageCounts(memoryIds?: string[]): Map<string, number> {
    if (memoryIds && memoryIds.length === 0) return new Map();

    const memoryIdSet = memoryIds ? new Set(memoryIds) : null;
    const filterClause = memoryIdSet && memoryIdSet.size > 0
      ? ` AND (${[...memoryIdSet].map(() => "tags LIKE ? ESCAPE '\\'").join(" OR ")})`
      : "";
    const filterParams = memoryIdSet
      ? [...memoryIdSet].map((memoryId) => `%"memory_id:${escapeLikePattern(memoryId)}"%`)
      : [];

    const actedRows = this.db.prepare(
      `SELECT tags FROM promoted
       WHERE archived_at IS NULL
       AND tags LIKE '%"signal:memory_used"%'
       ${filterClause}`
    ).all(...filterParams) as Array<{ tags: string }>;

    const memoryIdCounts = new Map<string, number>();
    for (const row of actedRows) {
      const tags = JSON.parse(row.tags) as string[];
      const memIdTag = tags.find((tag) => tag.startsWith("memory_id:"));
      if (!memIdTag) continue;

      const memId = memIdTag.slice("memory_id:".length);
      if (memoryIdSet && !memoryIdSet.has(memId)) continue;
      memoryIdCounts.set(memId, (memoryIdCounts.get(memId) ?? 0) + 1);
    }

    return memoryIdCounts;
  }
}
