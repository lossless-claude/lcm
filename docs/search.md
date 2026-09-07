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
lcm bench build --project /path/to/project --n 20 --generator llm
lcm bench run   --project /path/to/project
```

- **`build`** samples ingested conversations and paraphrases one user prompt per session.
  `--generator llm` calls your configured summarizer (including its local OpenAI-compatible endpoint).
  Disabled or mock summarizers cannot produce an LLM benchmark; provider failures do not silently
  switch to mechanical questions. Review generated questions for a specific subject, correct source
  session, realistic wording, and representative coverage before relying on a score.
  The default `--generator mechanical` requires no model and prints a diagnostic-only warning.
  Empty, copied, generic session-only, or duplicate questions are rejected; build reports skipped
  questions and may produce fewer than `--n`. If none survive, no file is written.
  Output defaults to `~/.lossless-claude/projects/<hash>/.lcm-bench.json`, local and uncommitted.
  Use `--out <file>` to choose another location. Invalid files are rejected by `run` before scoring.
  Both `build --help` and `run --help` show usage without generating questions or running searches.
- **`run`** uses the retrieval engine behind `lcm search`, deduplicates matches by session for
  scoring, and reports:

  | metric | what it tells you |
  |---|---|
  | `recall@5` (search) | single-source hit@5: fraction whose recorded source session appears in the top 5 |
  | `recall@5` (grep) | OR over parsed message text in SQLite, ranked by matching message count; not raw-JSONL grep |
  | empty-result rate | fraction returning zero results — the worst failure mode |
  | p95 latency | a retrieval path slower than reading the file is not worth calling |

  The metric named `recall@5` is a single-source hit rate, not complete relevance recall:
  another session may also answer the question. Review and record those cases before interpreting
  misses. Ground truth from one sampled prompt cannot prove that its session is the only valid answer.
  The grep baseline searches parsed messages; results from external raw-JSONL grep are a different
  experiment and must not be compared as if the corpus and ranking were identical.

  Full per-question outcomes land in `.lcm-bench-results.json` in the project memory directory,
  even when `--bench-file` points elsewhere.
  `--json` prints the machine-readable report to stdout.

Example output:

```text
  recall@5  search 17/20 (85%)  vs  grep 12/20 (60%)
  empty results  1/20 (5%)
  p95 latency    3.2ms
```

### Manually reviewed queries

Real user wording and short lookups are first-class benchmark inputs. In a version-1 benchmark
file, set each curated query's `generator` to `"manual"` (and the file-level `generator` to
`"manual"` for an entirely curated set). Keep `id`, `sessionId`, `prompt`, and `question` on each
entry: `sessionId` identifies the expected source, `prompt` records the source/context, and
`question` is the exact query to run. The prompt may equal the query.

Manual queries require nonempty text and a nonempty source session; duplicate query text is
rejected. They may contain actual copied user questions, short keywords, or identifiers such as
`PR #1462`, without a question mark. Generated `llm` and `mechanical` entries still undergo the
stricter paraphrase and generic-question checks. Marking an entry manual records curation; it does
not automatically prove relevance judgments or corpus representativeness.

## Synthetic regression gate and opt-in real-corpus gate

`test/search/recall-fixtures.test.ts` runs the committed synthetic corpus and fails the build on:

| check | threshold |
|---|---|
| recall@5 | ≥ 0.60 |
| recall@5 vs grep baseline | strictly greater |
| empty-result rate | ≤ 10% |
| p95 query latency | ≤ 500 ms |

Thresholds ratchet upward as retrieval improves; they are never tuned down to make a build pass.
A passing synthetic gate proves regression coverage, not release quality. Published quality numbers
must come from a reviewed, representative real corpus. LLM generation alone does not establish
question quality or corpus representativeness.

To opt into the same thresholds against a reviewed local benchmark:

```bash
LCM_REAL_BENCH_FILE=/absolute/path/to/.lcm-bench.json \
LCM_REAL_BENCH_PROJECT=/absolute/path/to/project \
npm test -- test/bench/real-corpus.test.ts
```

The real-corpus test is **skipped** when either variable is absent; a configured missing or invalid
file fails. Questions and source database remain local. A skipped gate or mechanical diagnostic
score is not evidence that a release meets real-world recall targets.

## Roadmap: semantic retrieval

Query preparation and OR-fallback bridge part of the vocabulary gap; the rest is semantic.
Embedding summaries and promoted memories and fusing with BM25 is the planned next step — the
`restoration.semanticTopK` / `restoration.semanticThreshold` config keys are reserved for it — but
it is independent of the query-preparation fix above, which is worth having regardless: an
unprocessed natural-language string passed to an AND-ing full-text engine returns empty by
construction.
