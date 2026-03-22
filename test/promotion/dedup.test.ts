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
    const mockSummarize = vi.fn();

    await deduplicateAndInsert({
      store,
      content: "Decided to use PostgreSQL for the database",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.8,
      summarize: mockSummarize,
      thresholds: { dedupBm25Threshold: 15, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it("merges when duplicate found above threshold", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert an existing entry
    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    const mockSummarize = vi.fn().mockResolvedValue("Merged: PostgreSQL is the database, confirmed twice");

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice after benchmarks",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.8,
      summarize: mockSummarize,
      // Use a near-zero threshold so our small test corpus triggers a match
      // (FTS5 BM25 ranks in a 1-doc corpus are around -0.000003, not -0.1)
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
    });

    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("Merged");
    // max(0.9, 0.8) - 0.1 = 0.8
    expect(results[0].confidence).toBe(0.8);
    expect(mockSummarize).toHaveBeenCalledOnce();
  });

  it("archives merged entry when confidence drops below 0.2", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    // Insert with very low confidence so decay pushes below 0.2
    store.insert({
      content: "Decided to use PostgreSQL for the database layer",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.2,
    });

    const mockSummarize = vi.fn().mockResolvedValue("Merged: PostgreSQL confirmed");

    await deduplicateAndInsert({
      store,
      content: "Confirmed PostgreSQL as the database choice",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.15,
      summarize: mockSummarize,
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
    });

    // Archived entry should not appear in search results
    const results = store.search("PostgreSQL database", 10);
    expect(results.length).toBe(0);
    expect(mockSummarize).toHaveBeenCalledOnce();
  });

  it("inserts as new when summarize fails during merge", async () => {
    const db = makeDb();
    const store = new PromotedStore(db);

    store.insert({
      content: "Decided to use PostgreSQL for everything",
      tags: ["decision"],
      projectId: "p1",
      confidence: 0.9,
    });

    const mockSummarize = vi.fn().mockRejectedValue(new Error("LLM unavailable"));

    await deduplicateAndInsert({
      store,
      content: "PostgreSQL confirmed after review",
      tags: ["decision"],
      projectId: "p1",
      sessionId: "s1",
      depth: 2,
      confidence: 0.8,
      summarize: mockSummarize,
      thresholds: { dedupBm25Threshold: 0.000001, mergeMaxEntries: 3, confidenceDecayRate: 0.1 },
    });

    // Should have 2 entries (original + new fallback)
    const results = store.search("PostgreSQL", 10);
    expect(results.length).toBe(2);
  });
});
