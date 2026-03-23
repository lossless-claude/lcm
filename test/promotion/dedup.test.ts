import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../../src/db/connection.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PromotedStore } from "../../src/db/promoted.js";
import { deduplicateAndInsert } from "../../src/promotion/dedup.js";

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
      confidence: 0.8,
      thresholds: { dedupBm25Threshold: 15, mergeMaxEntries: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
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
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3 },
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
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3 },
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
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3 },
    });

    const results = store.search("PostgreSQL", 10);
    // Only 1 result: the canonical (incoming is archived and not searchable)
    expect(results.length).toBe(1);
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
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    // Confidence should upgrade to incoming's higher value: max(0.6, 0.95) = 0.95
    expect(results[0].confidence).toBe(0.95);
  });
});
