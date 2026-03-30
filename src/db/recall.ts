import type { DatabaseSync } from "node:sqlite";

export interface RecallStats {
  memoriesSurfaced: number;
  memoriesActedUpon: number;
  recallPrecision: number | null;
  topRecalled: Array<{ id: string; content: string; actCount: number }>;
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

  getStats(): RecallStats {
    // Distinct memories that have ever been surfaced
    const surfacedRow = this.db.prepare(
      `SELECT COUNT(DISTINCT memory_id) as count FROM recall_surfacing`
    ).get() as { count: number };
    const memoriesSurfaced = surfacedRow.count;

    // Find all signal:memory_used entries in promoted, extract the referenced memory_id:<uuid> tag
    const actedRows = this.db.prepare(
      `SELECT tags FROM promoted
       WHERE archived_at IS NULL
       AND tags LIKE '%"signal:memory_used"%'`
    ).all() as Array<{ tags: string }>;

    // Count how many times each memory was acted upon
    const memoryIdCounts = new Map<string, number>();
    for (const row of actedRows) {
      const tags = JSON.parse(row.tags) as string[];
      const memIdTag = tags.find((t) => t.startsWith("memory_id:"));
      if (memIdTag) {
        const memId = memIdTag.slice("memory_id:".length);
        memoryIdCounts.set(memId, (memoryIdCounts.get(memId) ?? 0) + 1);
      }
    }

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
}
