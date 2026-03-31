import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PromotedRow = {
  id: string;
  content: string;
  tags: string;
  source_summary_id: string | null;
  project_id: string;
  session_id: string | null;
  depth: number;
  confidence: number;
  created_at: string;
  archived_at: string | null;
};

export type InsertParams = {
  content: string;
  tags?: string[];
  sourceSummaryId?: string;
  projectId: string;
  sessionId?: string;
  depth?: number;
  confidence?: number;
};

export type SearchResult = {
  id: string;
  content: string;
  tags: string[];
  projectId: string;
  sessionId: string | null;
  confidence: number;
  createdAt: string;
  rank: number;
};

export class PromotedStore {
  constructor(private db: DatabaseSync) {}

  insert(params: InsertParams): string {
    const id = randomUUID();
    const tags = JSON.stringify(params.tags ?? []);

    this.db.prepare(
      `INSERT INTO promoted (id, content, tags, source_summary_id, project_id, session_id, depth, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.content,
      tags,
      params.sourceSummaryId ?? null,
      params.projectId,
      params.sessionId ?? null,
      params.depth ?? 0,
      params.confidence ?? 1.0,
    );

    // Sync to FTS5
    const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (row) {
      this.db.prepare(
        "INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)"
      ).run(row.rowid, params.content, tags);
    }

    return id;
  }

  getById(id: string): PromotedRow | null {
    return (this.db.prepare("SELECT * FROM promoted WHERE id = ?").get(id) as PromotedRow) ?? null;
  }

  search(query: string, limit: number, filterTags?: string[], projectId?: string): SearchResult[] {
    const sanitized = query
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(" OR ");

    if (!sanitized) return [];

    const projectFilter = projectId ? "AND p.project_id = ?" : "";
    const queryParams: (string | number)[] = [sanitized];
    if (projectId) queryParams.push(projectId);
    queryParams.push(limit);

    const rows = this.db.prepare(
      `SELECT p.id, p.content, p.tags, p.project_id, p.session_id, p.confidence, p.created_at, rank
       FROM promoted_fts fts
       JOIN promoted p ON p.rowid = fts.rowid
       WHERE promoted_fts MATCH ?
         AND p.archived_at IS NULL
         ${projectFilter}
       ORDER BY rank, p.confidence DESC, p.created_at ASC
       LIMIT ?`
    ).all(...queryParams) as Array<PromotedRow & { rank: number }>;

    let results = rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tags) as string[],
      projectId: r.project_id,
      sessionId: r.session_id,
      confidence: r.confidence,
      createdAt: r.created_at,
      rank: r.rank,
    }));

    if (filterTags && filterTags.length > 0) {
      results = results.filter((r) => filterTags.every((t) => r.tags.includes(t)));
    }

    return results;
  }

  getAll(opts?: { projectId?: string; since?: string; tags?: string[] }): PromotedRow[] {
    let sql = "SELECT * FROM promoted WHERE archived_at IS NULL";
    const params: (string | number)[] = [];

    if (opts?.projectId) {
      sql += " AND project_id = ?";
      params.push(opts.projectId);
    }
    if (opts?.since) {
      sql += " AND created_at >= ?";
      params.push(opts.since);
    }
    sql += " ORDER BY created_at ASC";

    let rows = this.db.prepare(sql).all(...params) as PromotedRow[];

    if (opts?.tags && opts.tags.length > 0) {
      rows = rows.filter((r) => {
        const rowTags = JSON.parse(r.tags) as string[];
        return opts.tags!.every((t) => rowTags.includes(t));
      });
    }

    return rows;
  }

  listContentPrefixes(limit: number): string[] {
    const rows = this.db.prepare(
      "SELECT content FROM promoted WHERE archived_at IS NULL LIMIT ?"
    ).all(limit) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  archive(id: string): void {
    const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as { rowid: number } | undefined;
    this.db.prepare("UPDATE promoted SET archived_at = datetime('now') WHERE id = ?").run(id);
    if (row) {
      this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
    }
  }

  deleteById(id: string): void {
    const row = this.db.prepare("SELECT rowid FROM promoted WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (row) {
      this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
    }
    this.db.prepare("DELETE FROM promoted WHERE id = ?").run(id);
  }

  update(id: string, fields: { content?: string; confidence?: number; tags?: string[] }): void {
    const row = this.db.prepare("SELECT rowid, content, tags FROM promoted WHERE id = ?").get(id) as
      | { rowid: number; content: string; tags: string }
      | undefined;
    if (!row) return;

    if (fields.content !== undefined) {
      const newTags = fields.tags !== undefined ? JSON.stringify(fields.tags) : row.tags;
      this.db.prepare(
        "UPDATE promoted SET content = ?, confidence = COALESCE(?, confidence), tags = ? WHERE id = ?"
      ).run(fields.content, fields.confidence ?? null, newTags, id);
      // Re-sync FTS5: delete old row and insert new one
      this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
      this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
        row.rowid,
        fields.content,
        newTags,
      );
    } else {
      if (fields.confidence !== undefined) {
        this.db.prepare("UPDATE promoted SET confidence = ? WHERE id = ?").run(fields.confidence, id);
      }
      if (fields.tags !== undefined) {
        const newTags = JSON.stringify(fields.tags);
        this.db.prepare("UPDATE promoted SET tags = ? WHERE id = ?").run(newTags, id);
        // Re-sync FTS5 tags
        this.db.prepare("DELETE FROM promoted_fts WHERE rowid = ?").run(row.rowid);
        this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
          row.rowid,
          row.content,
          newTags,
        );
      }
    }
  }

  /**
   * Find promoted memories that are candidates for staleness review.
   * A memory is stale when it is old enough AND has not been acted upon recently.
   */
  findStale(opts: {
    staleAfterDays: number;
    staleSurfacingWithoutUseLimit: number;
    projectId?: string;
  }): Array<PromotedRow & { surfacingCount: number; usageCount: number; daysSinceCreated: number }> {
    const cutoffMs = Date.now() - opts.staleAfterDays * 24 * 60 * 60 * 1000;
    // Use SQLite datetime format (YYYY-MM-DD HH:MM:SS) to match created_at,
    // which is stored via datetime('now'). ISO-8601 with T/Z sorts incorrectly.
    const cutoff = new Date(cutoffMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

    let sql = `SELECT * FROM promoted WHERE archived_at IS NULL AND created_at < ?`;
    const params: (string | number)[] = [cutoff];

    if (opts.projectId) {
      sql += " AND project_id = ?";
      params.push(opts.projectId);
    }
    sql += " ORDER BY created_at ASC";

    const rows = this.db.prepare(sql).all(...params) as PromotedRow[];
    if (rows.length === 0) return [];

    // Batch: get surfacing counts for all candidate IDs in one query
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    const surfacingRows = this.db.prepare(
      `SELECT memory_id, COUNT(*) as count FROM recall_surfacing
       WHERE memory_id IN (${placeholders})
       GROUP BY memory_id`
    ).all(...ids) as Array<{ memory_id: string; count: number }>;
    const surfacingMap = new Map(surfacingRows.map((r) => [r.memory_id, r.count]));

    // Batch: count usage via signal:memory_used tags in one query
    const usageClauses = ids.map(() =>
      `tags LIKE '%"signal:memory_used"%' AND tags LIKE ?`
    );
    // Simpler approach: single query counting rows that match any target id
    const usageRows = this.db.prepare(
      `SELECT tags FROM promoted
       WHERE archived_at IS NULL
       AND tags LIKE '%"signal:memory_used"%'`
    ).all() as Array<{ tags: string }>;
    const usageMap = new Map<string, number>();
    for (const row of usageRows) {
      for (const id of ids) {
        if (row.tags.includes(`"memory_id:${id}"`)) {
          usageMap.set(id, (usageMap.get(id) ?? 0) + 1);
        }
      }
    }

    const result: Array<PromotedRow & { surfacingCount: number; usageCount: number; daysSinceCreated: number }> = [];

    for (const row of rows) {
      const surfacingCount = surfacingMap.get(row.id) ?? 0;
      const usageCount = usageMap.get(row.id) ?? 0;
      const daysSinceCreated = Math.floor((Date.now() - Date.parse(row.created_at)) / (24 * 60 * 60 * 1000));

      const surfacedWithoutUse = surfacingCount >= opts.staleSurfacingWithoutUseLimit && usageCount === 0;
      const purelyOld = surfacingCount === 0 && usageCount === 0;

      if (surfacedWithoutUse || purelyOld) {
        result.push({ ...row, surfacingCount, usageCount, daysSinceCreated });
      }
    }

    return result;
  }

  /** Revive a previously archived memory back to active status. */
  revive(id: string): void {
    const row = this.db.prepare("SELECT rowid, content, tags FROM promoted WHERE id = ?").get(id) as
      | { rowid: number; content: string; tags: string }
      | undefined;
    if (!row) return;

    // Wrap in transaction so the row and FTS stay in sync
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE promoted SET archived_at = NULL WHERE id = ?").run(id);
      // Re-add to FTS — ignore if already present
      try {
        this.db.prepare("INSERT INTO promoted_fts (rowid, content, tags) VALUES (?, ?, ?)").run(
          row.rowid, row.content, row.tags
        );
      } catch { /* already in FTS — non-fatal */ }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
