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
including AND and single-keyword queries, before candidate limits are applied. Among the
candidates kept, newer matches break relevance ties. Regex lookup remains newest-first. When the
all-term match returns fewer candidates than the limit, the remaining slots are filled with
BM25-ranked any-term matches.

The SQL behind each source orders by `rank` alone, the one ordering FTS5 consumes itself, so the
join to the source row and the `snippet()` call run only for the rows the limit keeps; the
tie-break is applied afterwards, over those rows. An ORDER BY that FTS5 cannot consume (`rank`
plus any second column) makes the planner sort in a temp b-tree instead: every matched row is
joined and snippeted before the limit applies, and the cost of a many-term OR query then scales
with the matched content read from disk rather than with the limit. Measured on a corpus of
1,800 sessions and 516k messages (1.1 GB of message text), where a many-term OR query matches
up to 159k rows, that shape answered one 14-term query in 6.6 s cold against 54 ms with `rank` alone;
over the corpus's 30-question benchmark, p95 went from 10.5 s to 0.76 s and p50 from 7.4 s to
0.4 s with the same hit@5, into the range the other corpora already answered in.
`test/search/relevance-order.test.ts` pins the plan shape.

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

### Language packs

Query preparation always drops English function words. Every other language gets a **language
pack**: a JSON file at `~/.lossless-claude/languages/<tag>.json` holding that language's function
words, generated once by the configured summarizer the first time a corpus in that language is
seen, and reused from then on. A pack applies to a query when its language is one the search is
configured for — the project's recorded author language for `query`, `search.pivotLanguage` for a
`pivotQuery` — matched on the primary subtag (`pt` and `pt-BR` are one language). So a pt-BR
question loses "que", "como", "para" the way an English one loses "what", "how", "for", and the
words that happen to appear in the query never choose a pack: a collision with another language's
function words changes nothing, and two languages in one string cannot activate a pack neither
activates alone. A project with no recorded language loses English function words only.

Packs are created by the daemon: after an ingest, a project with no recorded language and at least
20 human turns (tool output pasted into a user turn does not count) is sampled, the model names the
language, the tag is written to the project's `meta.json` as `language`, and the pack is generated if
this machine has none. The same step generates the pack for `search.pivotLanguage` when it is
neither English (which ships in code) nor the author's language, and does so again on every later
ingest for a project whose language was already recorded, so a pivot configured after detection
still gets a pack. `lcm bench build --generator llm` ensures both packs the same way on the corpus
it detects. A mock or disabled summarizer skips the step; a provider failure is logged once per
project per daemon lifetime and not retried until restart. Without a pack, a question in that
language goes through whole, function words included.

Packs are plain JSON, reviewable and hand-editable; deleting one makes the next detection regenerate
it. On the 74 pt-BR bench questions built at `ea10a75`, dropping pt-BR function words alone moved
hit@5 from 0.419 to 0.486 (+7 / −2) with no model call at search time. `LCM_LANGUAGES_DIR` points
the loader elsewhere; the test suite uses it so no test reads a developer's real packs.

### Cross-language queries: `pivotQuery`

Dropping the author language's function words is not the whole gap. When the author writes in one
language and the text that answers is mostly in another, the query has to reach both vocabularies.
`lcm_search` takes an optional `pivotQuery` for that: the caller's own translation of `query` into
`search.pivotLanguage` (default `en`). The daemon prepares each string separately — `query` under
the author language's pack, `pivotQuery` under the pivot language's — and searches the union of the
two term sets, so a hit through either side counts. A missing, empty or term-equivalent `pivotQuery`
leaves the single-language path untouched, and `lcm grep` / `lcm_grep` are not affected at all.

The translation is the caller's because the caller is already a model: no model call is added inside
the daemon at query time. So the caller has to be told when one is worth making. The recorded author
language and the pivot language travel in three places: the `lcm_search` tool description (when they
differ), a `/search` response (`authorLanguage`, `pivotLanguage`, once a language has been detected
for the project), and the `<memory-context>` block the prompt hook emits (when they differ). The
hint is reserved out of `restoration.maxInjectedMemoryBytes` before hints are selected, so the block
does not grow past its budget.

The ceiling experiment behind the design translated 74 pt-BR questions over three corpora with a
model instead of a caller: original alone 0.486 hit@5, translation alone 0.649, both ORed with the
original's function words still in 0.473, original minus its function words plus the translation
0.716. Expansion is additive rather than a replacement because the corpus whose own content is in
the author's language is the one where replacing loses.

Those are the numbers that chose the shape, not a measurement of this implementation: the
translations came from a model, not from a caller, and the store has changed since. Read 0.716 as
the ceiling the design was aiming at.

The implementation itself, at `f41c636` (packs chosen by configured language), measured with the
translations written by the calling agent from the tool description — the same path a real
`lcm_search` call takes — through `lcm bench run` with a `pivotQuery` on each question:

| arm | corpus | questions | `query` alone | with `pivotQuery` | Δ |
|---|---|---|---|---|---|
| tune | `lcm` (this repository, en, 284 sessions) | 30, built at `ea10a75` | 8/30 = 0.267 | 14/30 = 0.467 | +6 / −0 |
| tune | an en corpus of 1773 sessions | 30, built at `ea10a75` | 13/30 = 0.433 | 13/30 = 0.433 | +3 / −3 |
| holdout | a pt-BR corpus of 383 sessions | 18 reviewed of 30, seed 20260916 | 15/18 = 0.833 | 14/18 = 0.778 | +0 / −1 |

Pooled over the tune group: 21/60 → 27/60. The holdout was built fresh (a seed no sweep had used,
12 generated questions dropped on review as unanswerable from memory) and graded once. Its one loss
is a labelled session dropping out of the top five; it is also the corpus whose own content is
pt-BR, where the ceiling experiment had already found the least to gain. A `pivotQuery` averaged
123–215 bytes per corpus, on the call the agent was making anyway.

English non-regression, `d733f1f` (the `main` before) against `f41c636`, same store, no
`pivotQuery`: six further en corpora (112 questions total) returned the same top-5 for every
question, and so did the two en tune-group corpora above and the 14-question pt-BR holdout set
built at `ea10a75`. The by-language selection changes nothing for a single-language project.

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
  prompts whose text occurs in exactly one session are sampled; harness boilerplate, repeated
  prompts, and pasted tool output (grep listings, `git push` transcripts, directory listings)
  are skipped. None of them can anchor a single-label question, and a question built from a
  listing asks about the listing rather than about anything a person wanted to recall.
  `--generator llm` calls your configured summarizer (including its local OpenAI-compatible endpoint).
  Disabled or mock summarizers cannot produce an LLM benchmark; provider failures do not silently
  switch to mechanical questions. Review generated questions for a specific subject, correct source
  session, realistic wording, and representative coverage before relying on a score.
  The default `--generator mechanical` requires no model and prints a diagnostic-only warning.
  Empty, copied, generic session-only, or duplicate questions are rejected; build reports skipped
  questions and may produce fewer than `--n`. An LLM question that reuses more than half of its
  source prompt's query terms is rejected too — it would measure keyword lookup rather than recall
  — so the LLM task prompt names the prompt's own words as forbidden. `run` applies the same
  ceiling when loading, which rejects `generator: "llm"` files built before it existed.
  LLM questions are written in the language the corpus's author asks in, not the language of the
  sampled prompt: a prompt is often pasted code or tool output in English while the person writes
  something else, and a question in the prompt's language would measure same-language paraphrase
  recall, a task the person never performs. The language is read once per build from a sample of
  the corpus's human turns and recorded on the file as `language` (a BCP 47 tag); `--language`
  overrides detection, and a build that cannot tell fails rather than defaulting to English.
  Mechanical templates are English, so a mechanical set records `en` whatever the corpus.
  The set a generator produces is not interchangeable with a hand-written one: it follows whatever
  provenance the corpus's sampled prompts happen to have, so compare directions
  across sets rather than absolute scores. If none survive, no file is written.
  Output defaults to `~/.lossless-claude/projects/<hash>/.lcm-bench.json`, local and uncommitted.
  Use `--out <file>` to choose another location. Invalid files are rejected by `run` before scoring.
  Both `build --help` and `run --help` show usage without generating questions or running searches.
Questions are sampled from the user's own sessions only. Subagent transcripts — the `agent-*`
sessions Claude Code writes for dispatched agents — are skipped, because `lcm search` does not
return them either, so a question labelled with one could never be answered.

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

  A question may carry a `pivotQuery`, the caller's translation into a pivot language; `run`
  combines it with the question exactly as `lcm_search` does, and the grep column ignores it. The
  pivot language is read from the file's own `pivotLanguage` (a BCP 47 tag, one value for the whole
  file — every `pivotQuery` in a set is written in the same language the way every `question` is),
  falling back to the configured `search.pivotLanguage` for files written before that field existed.
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
the same questions and are comparable. Each row also prints the corpus's session count: a live
corpus grows between runs, and a delta measured over different content is not a delta.
`build` uses the configured summarizer and detects each corpus's language as `lcm bench build
--generator llm` does; `LCM_BENCH_LANGUAGE` overrides detection for every corpus in the run.
Sets built before the language was recorded measure a different task (English questions over a
mixed corpus) and are not comparable with sets built after.

### Tuning against one half, grading against the other

A parameter chosen on the same questions that report the score is fitted, not measured — the
score stops being evidence. `LCM_BENCH_GROUP` splits the corpora in two so the two roles stay
apart:

```bash
LCM_BENCH_GROUP=tune    npx tsx scripts/bench-corpora.mts run   # sweep a parameter here
LCM_BENCH_GROUP=holdout npx tsx scripts/bench-corpora.mts run   # grade, once, here
```

The split is by corpus (`HELD_OUT_CORPORA` in the script), not by question, so no session appears
on both sides. Build the held-out questions with `LCM_BENCH_SEED` set to something other than the
default, so they are a different sample from the ones any sweep has already seen; `LCM_BENCH_N`
raises the count per corpus. Grade the held-out group **once**, after the parameter is fixed — a
second look at it makes it a tuning set too.

These are generated questions: diagnostic only, never release evidence. What the
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
