# Search & recall benchmarking

`lcm search <query>` answers natural-language questions across the episodic layer (messages +
summaries) and the promoted layer (long-term memories).

## How queries are prepared

Passing a question verbatim into FTS5 returns empty by construction: FTS5 **ANDs** the terms of a
multi-word query, so an eight-word question requires all eight words to co-occur in one document.
`lcm search` prepares every query before it reaches FTS5 (see `src/store/fts5-query.ts`):

1. **Tokenize** — split on non-word characters (Unicode-aware, matching the `unicode61` tokenizer),
   lowercase, dedupe.
2. **Drop English stopwords** — "how", "did", "we", "the", … carry no discriminative power but
   would otherwise participate in the AND. If every word is a stopword, the original words are kept.
3. **Try AND** over the remaining content terms (most precise).
4. **Fall back to OR** ranked by BM25 when AND matches nothing — the same behavior as a `grep` that
   ORs its terms, but with ranking.
5. **Fall back to a substring LIKE scan** when the question's vocabulary does not overlap the corpus
   at all (porter stems diverge — "undo" never stems to "revert"), so a natural-language question
   never returns empty by construction.

Single-keyword queries (`lcm search worktrees`) keep strict semantics — no LIKE fallback for a
one-term lookup.

Single-word matches and BM25 relevance come from FTS5; see [fts5.md](./fts5.md) if your Node
runtime lacks FTS5 (search then falls back to LIKE over the same prepared terms).

### Failure visibility

The `/search` daemon route never fails hard on a bad query, but it never fails silently either:
layer errors are logged with `console.warn` and surfaced in the response as
`{ "episodic": [...], "promoted": [...], "errors": ["episodic: …"] }`. An empty result set with an
`errors` key means something broke; an empty result set without it means nothing matched.

## Measuring recall: `lcm bench`

The synthetic fixtures in `test/fixtures/recall/` prove the pipeline works, but they are small and
clean. Real recall numbers come from your own ingested sessions:

```bash
lcm bench build --project /path/to/project --n 20
lcm bench run   --project /path/to/project
```

- **`build`** samples ingested conversations, extracts a distinctive user prompt from each, and
  writes a question that avoids the prompt's own content words (the same vocabulary-divergence rule
  as the committed fixtures). Output goes to
  `~/.lossless-claude/projects/<hash>/.lcm-bench.json` — local only, never committed, and
  `.lcm-bench*.json` is gitignored in case you keep one in a worktree.
- **`run`** executes each question through the same code path as `lcm search` and reports:

  | metric | what it tells you |
  |---|---|
  | `recall@5` (search) | fraction of questions whose source session appears in the top 5 |
  | `recall@5` (grep) | the same questions against a naive OR-`grep` floor — if grep wins, the index is not earning its cost |
  | empty-result rate | fraction returning zero results — the worst failure mode |
  | p95 latency | a retrieval path slower than reading the file is not worth calling |

  Full per-question outcomes land in `.lcm-bench-results.json` next to the benchmark file.
  `--json` prints the machine-readable report to stdout.

Example output:

```text
  recall@5  search 17/20 (85%)  vs  grep 12/20 (60%)
  empty results  1/20 (5%)
  p95 latency    3.2ms
```

## The CI gate

`test/search/recall-fixtures.test.ts` runs the committed synthetic corpus and fails the build on:

| check | threshold |
|---|---|
| recall@5 | ≥ 0.60 |
| recall@5 vs grep baseline | strictly greater |
| empty-result rate | ≤ 10% |
| p95 query latency | ≤ 500 ms |

Thresholds ratchet upward as retrieval improves; they are never tuned down to make a build pass.
Published quality numbers always come from `lcm bench` on a real corpus, never from the synthetic
fixtures.

## Roadmap: semantic retrieval

Query preparation and OR-fallback bridge part of the vocabulary gap; the rest is semantic.
Embedding summaries and promoted memories and fusing with BM25 is the planned next step — the
`restoration.semanticTopK` / `restoration.semanticThreshold` config keys are reserved for it — but
it is independent of the query-preparation fix above, which is worth having regardless: an
unprocessed natural-language string passed to an AND-ing full-text engine returns empty by
construction.
