# LLM-Free Structural Convergence for `lcm promote`

**Date:** 2026-03-23
**Status:** Draft

## Problem

`lcm promote` deduplicates promoted memory entries by calling an LLM (via Claude CLI) to merge near-duplicate content. This causes two critical failures:

1. **HeadersTimeoutError** — The CLI→daemon HTTP fetch has a default headers timeout (~30s). The daemon blocks while waiting for Claude CLI to complete the merge, exceeding the timeout.
2. **Token explosion at scale** — The merge prompt concatenates all duplicate entries plus the new content. As project history grows, this produces unbounded prompt sizes and escalating LLM costs.

## Current Flow

`deduplicateAndInsert()` in `src/promotion/dedup.ts`:

1. BM25 search finds near-duplicate candidates via FTS5
2. Filter candidates where `rank <= -dedupBm25Threshold` (more negative = better match)
3. If duplicates found:
   - Combine all duplicate entries + new content into a merge prompt
   - Call `summarize()` (LLM) to produce merged content
   - Hard-delete old duplicates via `deleteById()`
   - Insert merged entry
4. If no duplicates: insert as new entry

The promote route in `src/daemon/routes/promote.ts` requires `getSummarizer()` — if the summarizer is unavailable, entries are silently skipped (never promoted).

## Design: Structural Convergence

Replace LLM-based content merge with structural convergence: multiple near-duplicate observations collapse toward the strongest canonical entry using only BM25 ranking and confidence scoring.

### New Flow

1. BM25 search finds near-duplicate candidates (unchanged)
2. Filter by BM25 threshold (unchanged)
3. If duplicates found:
   a. Pick the best BM25 match (`duplicates[0]`) as the **canonical** entry
   b. Refresh canonical confidence: `Math.max(canonical.confidence, incoming.confidence)`
   c. Archive weaker duplicates via `store.archive()` (soft-delete — preserves history, removes from FTS5 index)
   d. Insert the incoming entry as archived (preserves complementary info for recovery)
   e. Return canonical entry's ID
4. If no duplicates: insert as new entry (unchanged)

### Rationale

- **DAG convergence without LLM**: Multiple paths to the same insight collapse to one canonical node. Weaker representations get archived. Same convergence property as the LLM merge, achieved structurally.
- **Confidence refresh**: Repeated observations of the same concept reinforce the canonical entry's confidence. `Math.max` ensures confidence can only increase on duplicate hits.
- **Complementary info preserved**: The incoming entry is inserted then archived, so complementary details are recoverable but don't pollute active search results.
- **No confidence decay on merge**: The current decay (`maxConfidence - confidenceDecayRate`) was designed for LLM merge quality uncertainty. Structural convergence doesn't degrade content, so decay is inappropriate.

### Trade-off: Complementary Information

When two near-duplicate entries carry complementary (not redundant) information — e.g., "use `ctx_batch_execute` for parallel fetches" vs "use `ctx_batch_execute` — max 5 commands per call" — structural convergence keeps the canonical but archives the complement. An LLM merge would combine them.

This is acceptable because:
- The archived entry is recoverable
- The current LLM path already degrades gracefully on failure (falls back to plain insert)
- Reliability and speed outweigh occasional information loss at the margin

## Changes

### `src/promotion/dedup.ts`

- Remove `summarize` from `DedupParams` type
- Remove `renderTemplate` import (no longer needed)
- Replace merge logic with structural convergence:
  - `store.update(canonical.id, { confidence })` to refresh canonical
  - `store.archive()` weaker duplicates
  - `store.insert()` + `store.archive()` incoming entry for recoverability
- Remove low-confidence archiving branch (now handled uniformly)

### `src/daemon/routes/promote.ts`

- Remove `getSummarizer()` call and `summarize` variable
- Remove `LcmSummarizeFn` import
- Remove the `else if (summarize)` guard — promote always runs
- Remove `summarize` from `deduplicateAndInsert` call

### `src/db/promoted.ts`

- No new methods needed — `update()` already handles `{ confidence }` updates without touching FTS5

### Config

- `mergeMaxEntries` config key name is now misleading (no merge happens). Follow-up rename to `dedupMaxCandidates`.

### Prompt template

- `prompts/promoted-merge.md` template is no longer used. Can be deleted.

## Testing

- Existing tests for `deduplicateAndInsert` need updating to remove `summarize` mock
- Test: no duplicates → insert as new
- Test: single duplicate above threshold → canonical refreshed, incoming archived
- Test: multiple duplicates → best match is canonical, others archived, incoming archived
- Test: confidence is `Math.max(canonical, incoming)`, never decays
- Test: promote route works without summarizer

## Non-Goals

- LLM merge as opt-in path (if needed later, belongs in a separate offline command)
- Config key rename (follow-up)
- CLI→daemon timeout fix (this design eliminates the root cause)
