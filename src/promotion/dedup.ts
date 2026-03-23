import type { PromotedStore } from "../db/promoted.js";

type DedupThresholds = {
  dedupBm25Threshold: number;
  mergeMaxEntries: number;
  confidenceDecayRate: number;
};

type DedupParams = {
  store: PromotedStore;
  content: string;
  tags: string[];
  projectId: string;
  sessionId?: string;
  depth: number;
  confidence: number;
  thresholds: DedupThresholds;
};

export async function deduplicateAndInsert(params: DedupParams): Promise<string> {
  const { store, content, tags, projectId, sessionId, depth, confidence, thresholds } = params;

  // Search for duplicates using FTS5
  // NOTE: store.search() is not project-scoped and may return results across all projects.
  // Duplicates are filtered by BM25 relevance; cross-project matches are possible but unlikely.
  const candidates = store.search(content, thresholds.mergeMaxEntries);

  // Filter to entries above BM25 threshold (rank is negative; more negative = better match)
  const duplicates = candidates.filter((c) => c.rank <= -thresholds.dedupBm25Threshold);

  if (duplicates.length === 0) {
    return store.insert({ content, tags, projectId, sessionId, depth, confidence });
  }

  // Structural convergence: pick best BM25 match as canonical
  // (duplicates is sorted by rank — most negative rank = best match = duplicates[0])
  const canonical = duplicates[0];
  const refreshedConfidence = Math.max(canonical.confidence, confidence);

  // NOTE: The following sequence (update + archive + insert + archive) is not wrapped
  // in a SQLite transaction. This is safe for the current single-threaded daemon, but
  // should be made atomic if concurrent promote calls are introduced in future.

  // Refresh canonical's confidence — repeated sightings reinforce the entry
  store.update(canonical.id, { confidence: refreshedConfidence });

  // Archive weaker duplicates (soft-delete: removed from FTS5, recoverable)
  for (let i = 1; i < duplicates.length; i++) {
    store.archive(duplicates[i].id);
  }

  // Insert incoming as archived for recoverability of complementary info
  const incomingId = store.insert({ content, tags, projectId, sessionId, depth, confidence });
  store.archive(incomingId);

  return canonical.id;
}
