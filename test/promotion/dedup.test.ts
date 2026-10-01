import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";
import { MAX_QUERY_TERMS } from "../../src/store/fts5-query.js";

const tempDirs: string[] = [];
afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-dedup-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const db = getLcmConnection(dbPath);
  runLcmMigrations(db);
  return db;
}

describe("deduplicateAndInsert", () => {
  it("inserts new entry when no duplicates exist", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    await deduplicateAndInsert({
      store,
      content: "Decided to use PostgreSQL for the database",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.2,
      newEntryConfidence: 0.8,
      thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.8);
    expect(store.getById(results[0].id)?.source_summary_id).toBeNull();
  });

  it("does not apply new-entry boost when deduping against an existing canonical", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.25,
    });

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.2,
      newEntryConfidence: 0.6,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(results[0].confidence).toBe(0.25);
  });

  it("refreshes canonical and archives incoming when duplicate found above threshold", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert an existing entry (canonical)
    const canonical = store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.8,
      // Use a near-zero threshold so our small test corpus triggers a match
      // (FTS5 BM25 ranks in a 1-doc corpus are around -0.000003, not -0.1)
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    // Only 1 result: the canonical (incoming is archived)
    expect(results.length).toBe(1);
    // Content should be the original canonical content (not merged)
    expect(results[0].content).toContain("database layer");
    // Confidence should be max(0.9, 0.8) = 0.9
    expect(results[0].confidence).toBe(0.9);
    // Returned ID should match canonical
    expect(results[0].id).toBe(canonical);
  });

  it.each(["sum_original", undefined])("keeps canonical provenance %s and archives incoming summary provenance", async (sourceSummaryId) => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const canonical = store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      sourceSummaryId,
      confidence: 0.9,
    });

    const id = await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["architecture"],
      projectId: "p1",
      sessionId: "s1",
      sourceSummaryId: "sum_incoming",
      depth: 2,
      confidence: 0.8,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    expect(id).toBe(canonical);
    expect(store.getById(canonical)?.source_summary_id).toBe(sourceSummaryId ?? null);
    const incoming = db.prepare("SELECT id FROM promoted WHERE id != ?").get(canonical) as { id: string };
    expect(store.getById(incoming.id)).toMatchObject({
      source_summary_id: "sum_incoming",
      archived_at: expect.any(String),
    });
  });

  it("archives weaker duplicates when multiple exist above threshold", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert two existing entries with different confidences
    const weakEntry = store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.7,
    });

    const strongEntry = store.insert({
      content: "PostgreSQL is the database choice for this project",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.6,
      // Use a near-zero threshold to match both existing entries
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    // Only 1 result: the strongest canonical (weaker ones are archived)
    expect(results.length).toBe(1);
    // strongEntry (confidence=0.9) is canonical; weakEntry (confidence=0.7) is archived
    expect(results[0].id).toBe(strongEntry);
    expect(store.getById(weakEntry)?.archived_at).not.toBeNull();
    // Confidence should be max(canonical.confidence=0.9, incoming.confidence=0.6) = 0.9
    expect(results[0].confidence).toBe(0.9);
  });

  it("archives incoming entry alongside canonical for recoverability", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert an existing entry (canonical)
    store.insert({
      content: "Decided to use PostgreSQL for the database",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.8,
    });

    await deduplicateAndInsert({
      store,
      content: "PostgreSQL confirmed after review process",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.7,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    // Only canonical is searchable
    const results = store.search("PostgreSQL", 10);
    expect(results.length).toBe(1);

    // Both rows exist in DB: canonical (active) + incoming (archived)
    const rows = db
      .prepare("SELECT archived_at FROM promoted WHERE project_id = ? ORDER BY rowid ASC")
      .all("p1") as Array<{ archived_at: string | null }>;
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.archived_at !== null).length).toBe(1);
  });

  it("upgrades confidence when incoming is higher than canonical", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.6,
    });

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice after extensive benchmarks",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.95,
      thresholds: { dedupBm25Threshold: 0.000001, dedupCandidateLimit: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    // Confidence should upgrade to incoming's higher value: max(0.6, 0.95) = 0.95
    expect(results[0].confidence).toBe(0.95);
  });

  // A summary is the dedup query, whole: without a bound, every distinct word in it became
  // one OR'd FTS5 term, run synchronously on the daemon's event loop against promoted_fts.
  it("searches a populated index with a bounded query when the content is a very long document", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);
    const word = (i: number) => `w${i.toString(36)}x`;
    for (let d = 0; d < 200; d++) {
      store.insert({
        content: Array.from({ length: 50 }, (_, k) => word((d * 37 + k * 11) % 3000)).join(" "),
        tags: ["decision"],
        projectId: "p1",
        confidence: 0.5,
      });
    }

    const matchExpressions: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql.includes("promoted_fts MATCH")) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: Parameters<typeof all>) => {
          matchExpressions.push(String(args[0]));
          return all(...args);
        }) as typeof statement.all;
      }
      return statement;
    });

    const id = await deduplicateAndInsert({
      store,
      content: Array.from({ length: 3000 }, (_, i) => word(i)).join(" "),
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.5,
      thresholds: { dedupBm25Threshold: 15, dedupCandidateLimit: 100 },
    });

    expect(id).toBeTruthy();
    expect(matchExpressions.length).toBeGreaterThan(0);
    for (const expression of matchExpressions) {
      expect(expression.split(" OR ").length).toBeLessThanOrEqual(MAX_QUERY_TERMS);
    }
  });
});
