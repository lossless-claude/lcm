import type { PromotedStore } from "../db/promoted.js";

type DedupThresholds = {
  dedupBm25Threshold: number;
  dedupCandidateLimit: number;
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

  // Search for duplicates using FTS5, scoped to this project at the SQL level
  const candidates = store.search(content, thresholds.dedupCandidateLimit, undefined, projectId);

  // Filter to entries above BM25 threshold (rank is negative; more negative = better match)
  const duplicates = candidates.filter(
    (c) => c.rank <= -thresholds.dedupBm25Threshold,
  );

  if (duplicates.length === 0) {
    return store.insert({ content, tags, projectId, sessionId, depth, confidence });
  }

  // Structural convergence: pick best BM25 match as canonical
  // (duplicates is sorted by rank — most negative rank = best match = duplicates[0])
  const canonical = duplicates[0];
  // Use max confidence across all matched duplicates + incoming to avoid losing strong signals
  const refreshedConfidence = Math.max(confidence, ...duplicates.map((d) => d.confidence));
  // Merge tags from canonical, all matched duplicates, and incoming to avoid losing tag signals
  const mergedTags = Array.from(
    new Set([...canonical.tags, ...duplicates.slice(1).flatMap((d) => d.tags), ...tags]),
  );

  store.transaction(() => {
    // Refresh canonical's confidence and tags — repeated sightings reinforce and enrich the entry
    store.update(canonical.id, { confidence: refreshedConfidence, tags: mergedTags });

    // Archive weaker duplicates (soft-delete: removed from FTS5, recoverable)
    for (let i = 1; i < duplicates.length; i++) {
      store.archive(duplicates[i].id);
    }

    // Insert incoming as archived for recoverability of complementary info
    store.archive(store.insert({ content, tags, projectId, sessionId, depth, confidence }));
  });

  return canonical.id;
}
