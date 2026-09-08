# Search & retrieval benchmarking

`lcm search <query>` answers natural-language questions across the episodic layer (messages +
summaries) and the promoted layer (long-term memories).

This native build has no external search backend dependency. Requests for another backend are
rejected explicitly; they are not silently evaluated as native search.

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

Full-text matches are ordered by BM25 relevance within each source (messages or summaries),
including AND and single-keyword queries, before candidate limits are applied. Newer matches
break relevance ties. Regex lookup remains newest-first. When the all-term match returns fewer
candidates than the limit, the remaining slots are filled with BM25-ranked any-term matches.

The search response then fuses message and summary candidates by session: each session scores
the sum of the reciprocal ranks of its best message and its best summary, so evidence present
in both sources rises. Results are emitted round-robin, one hit per session per pass, with a
session's messages before its summaries, so a small limit spans several sessions.

Native `search` expands each selected episodic result around its FTS match into at most 1,000
UTF-16 characters of exact retained source text. Results include `span.start`, `span.end`,
`sourceHash` (SHA-256 of the complete retained text), and `snippetTruncated`. Spans describe
positions in that source revision; astral Unicode characters are not split at excerpt edges.
Short sources are returned whole. This adds readable context without changing result ranking.
`grep` keeps its compact snippets, and promoted memories retain their existing response format.

An episodic search uses one SQLite read snapshot for matching and source context. With the default
limit of five, episodic snippet text is bounded at 5,000 characters; metadata and promoted-memory
content are additional. This is a character cap, not a model-token budget or proof of answer support.

Single-word matches and BM25 relevance come from FTS5; see [fts5.md](./fts5.md) if your Node
runtime lacks FTS5 (search then falls back to LIKE over the same prepared terms).

### Failure visibility

The `/search` daemon route never fails hard on a bad query, but it never fails silently either:
layer errors are logged with `console.warn` and surfaced in the response as
`{ "episodic": [...], "promoted": [...], "errors": ["episodic: …"] }`. An empty result set with an
`errors` key means something broke; an empty result set without it means nothing matched.

## Measuring retrieval: `lcm bench`

The synthetic fixtures in `test/fixtures/recall/` prove the pipeline works, but they are small and
clean. Real numbers come from your own ingested sessions:

```bash
lcm bench build --project /path/to/project --n 20 --generator llm
lcm bench run   --project /path/to/project
```

- **`build`** samples ingested conversations and paraphrases one user prompt per session. Only
  prompts whose text occurs in exactly one session are sampled; harness boilerplate and repeated
  prompts are skipped, because neither can anchor a single-label question.
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
  | `hit@5` (search) | fraction of questions where any labelled session (`sessionId` or `sessionIds`) appears in the top 5 |
  | `hit@5` (grep) | real ripgrep over the same retained messages, summaries and promoted memories, ranked by matched terms then occurrences; falls back to a labelled SQLite LIKE baseline when `rg` is missing. Not raw-JSONL grep |
  | empty-result rate | fraction returning zero results — the worst failure mode |
  | p95 latency | a retrieval path slower than reading the file is not worth calling |

  The reported `searchHitRate` and `grepHitRate` are labelled-session hit rates, not complete
  relevance recall: a session outside the labels may also answer the question. When review finds
  such a session, add it to the query's optional `sessionIds` list — every session listed there is
  scored as a hit alongside `sessionId`. Do not quote a hit rate as a recall figure.
  Keep a curated file outside the default path (`--out` / `--bench-file`): `bench build`
  overwrites `.lcm-bench.json` without merging, so hand-added labels there are lost.
  The grep baseline searches the retained corpus; results from external raw-JSONL grep are a different
  experiment and must not be compared as if the corpus and ranking were identical.

  Full per-question outcomes land in `.lcm-bench-results.json` in the project memory directory,
  even when `--bench-file` points elsewhere.
  `--json` prints the machine-readable report to stdout.

Example output:

```text
  hit@5  search 17/20 (85%)  vs  grep 12/20 (60%)
  empty results  1/20 (5%)
  p95 latency    3.2ms
```

### Measuring a ranking change across corpora

One benchmark cannot separate a ranking improvement from noise. `scripts/bench-corpora.mts`
scores several local projects at once and pools the result:

```bash
npx tsx scripts/bench-corpora.mts build   # (re)generate one question set per corpus
npx tsx scripts/bench-corpora.mts run     # score them all, print the pooled hit rate
```

Corpora come from `LCM_BENCH_CORPORA` (the platform path delimiter — `:`, or `;` on Windows) or, unset, from every
ingested project whose database is large enough to hold one. Question sets are written next to
each project database as `.lcm-bench-validation.json` and the seed is fixed, so two runs score
the same questions and are comparable.

These are mechanically generated questions: diagnostic only, never release evidence. What the
harness is for is the **direction** of a change and whether one corpus disagrees with another.
Two ranking changes that read as clean wins on a single 13-question set did not survive it —
query-term coverage in session fusion was +2 there and +1 pooled over 221 questions, and
enlarging the candidate pool came out negative while pushing p95 past the latency budget.

Require a non-negative direction on every corpus, not just a better pooled number.

### Manually reviewed queries

Real user wording and short lookups are first-class benchmark inputs. In a version-1 benchmark
file, set each curated query's `generator` to `"manual"` (and the file-level `generator` to
`"manual"` for an entirely curated set). Keep `id`, `sessionId`, `prompt`, and `question` on each
entry: `sessionId` identifies the expected source, `prompt` records the source/context, and
`question` is the exact query to run. The prompt may equal the query. Add `sessionIds` when other
sessions answer the question too; each one counts as a hit.

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
