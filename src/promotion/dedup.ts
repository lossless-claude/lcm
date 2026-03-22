import type { PromotedStore } from "../db/promoted.js";
import { renderTemplate } from "../prompts/loader.js";

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
  summarize: (text: string) => Promise<string>;
  thresholds: DedupThresholds;
};

export async function deduplicateAndInsert(params: DedupParams): Promise<string> {
  const { store, content, tags, projectId, sessionId, depth, confidence, summarize, thresholds } = params;

  // Search for duplicates using FTS5
  const candidates = store.search(content, thresholds.mergeMaxEntries);

  // Filter to entries above BM25 threshold (rank is negative; more negative = better match)
  const duplicates = candidates.filter((c) => c.rank <= -thresholds.dedupBm25Threshold);

  if (duplicates.length === 0) {
    return store.insert({ content, tags, projectId, sessionId, depth, confidence });
  }

  // Merge: combine all duplicate entries + new content
  const allEntries = [...duplicates.map((d) => d.content), content];
  const entriesText = allEntries.map((e, i) => `Entry ${i + 1}:\n${e}`).join("\n\n");
  const mergePrompt = renderTemplate("promoted-merge", { entries: entriesText });

  let mergedContent: string;
  try {
    mergedContent = await summarize(mergePrompt);
  } catch {
    // Merge failed — insert as new entry rather than losing data
    return store.insert({ content, tags, projectId, sessionId, depth, confidence });
  }

  if (!mergedContent.trim()) {
    return store.insert({ content, tags, projectId, sessionId, depth, confidence });
  }

  // Calculate merged confidence
  const maxConfidence = Math.max(confidence, ...duplicates.map((d) => d.confidence));
  const mergedConfidence = Math.max(0, maxConfidence - thresholds.confidenceDecayRate);

  // Delete old duplicates
  for (const dup of duplicates) {
    store.deleteById(dup.id);
  }

  // Archive if confidence too low — soft-delete, don't surface
  if (mergedConfidence < 0.2) {
    const id = store.insert({ content: mergedContent, tags, projectId, sessionId, depth, confidence: mergedConfidence });
    store.archive(id);
    return id;
  }

  // Insert merged entry
  return store.insert({ content: mergedContent, tags, projectId, sessionId, depth, confidence: mergedConfidence });
}
