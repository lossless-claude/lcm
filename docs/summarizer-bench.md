# Summarizer eval bench

Scores a candidate summarizer model on the work lcm actually asks of it. The bench runs the real `CompactionEngine` with the production `/compact` configuration against a real session loaded into an in-memory SQLite database — real stores, real migrations — and records every summarizer call.

It is opt-in. With no `LCM_EVAL_*` variables set, only the offline tests run and no API is called.

## Running it

```bash
LCM_EVAL_MODEL=openai/gpt-oss-120b \
LCM_EVAL_CORPUS_DIR=test/bench/corpus \
npx vitest run --dir test test/bench/summarizer-eval.test.ts
```

Results land in `test/bench/results/` as one JSON per model, provider, variant, session and run. Both `test/bench/corpus/` and `test/bench/results/` are gitignored — they hold real conversation content and must never be committed.

## Environment

| Variable | Meaning |
|---|---|
| `LCM_EVAL_MODEL` | Candidate model id. **Required** — without it the live block is skipped. |
| `LCM_EVAL_CORPUS_DIR` | Directory of `<label>.json` exports. **Required**. A set-but-missing path is an error, not a skip. |
| `LCM_EVAL_PROVIDER` | `openrouter` (default), `openai`, or `claude-process`. An unrecognised value is rejected. |
| `LCM_EVAL_BASE_URL` | `openai` provider only: the OpenAI-compatible endpoint. `LCM_EVAL_API_KEY` is optional. |
| `LCM_EVAL_RUNS` | Runs per session, default `1`. Must be a positive integer. |
| `LCM_EVAL_SESSIONS` | Comma-separated labels to run; default is every session in the corpus. |
| `LCM_EVAL_REASONING` | HTTP providers: the JSON sent as `reasoning`, e.g. `{"enabled":false}`. |
| `LCM_EVAL_REASONING_EFFORT` | Shorthand for `LCM_EVAL_REASONING={"effort":"<value>"}`. |
| `LCM_EVAL_DISABLE_THINKING` | HTTP providers: `1` sends `chat_template_kwargs.enable_thinking=false`, for Qwen-style servers. |

`openrouter` needs `OPENROUTER_API_KEY`. The provider and the reasoning knobs are part of a run's identity and appear in the result filename, so the same model measured under different settings does not overwrite itself.

## Building a corpus

Every corpus session is one JSON file named for its label. Export one from a per-project lcm database:

```bash
test/bench/export-eval-session.sh \
  ~/.lossless-claude/projects/<project-id>/db.sqlite 42 test/bench/corpus/long-refactor.json
```

`<project-id>` is the sha256 of the project's canonicalized working directory (`projectId` in `src/daemon/project.ts`). To find the one for a given project:

```bash
npm run build && node -e 'import("./dist/src/daemon/project.js").then(p => console.log(p.projectDbPath(process.argv[1])))' /path/to/project
```

The database is opened read-only through the immutable URI — the only form that opens these WAL databases without taking a lock, so it is safe to run against a live install. A conversation id that matches no messages fails rather than leaving an empty file behind.

A synthetic session carrying planted facts is always appended to the corpus, so fact-survival is scored even on a corpus of one.

## What it scores

Per run, in `totals`:

- **`formatPass` / `formatTotal`** — calls whose summary honoured the prompt contract: a `Files:` line on leaf summaries, an `Expand for details about:` trailer on all of them.
- **`maxTokensHits`** — calls whose output reached the production output cap, meaning the summary was cut off.
- **`inputTokens` / `outputTokens` / `latencyMs`** — totals across every call.
- **`costUsd`** — the real charged cost, or `null` when the provider prices nothing. `null` means *unknown*, never *free*; only OpenRouter and the Claude CLI report a cost today (see #345).
- **`failedCalls`** and the top-level `incomplete`, set when the engine itself errored. An incomplete run reports no fact survival, because chunks were left un-summarized and the score would be meaningless.
- **`plantedFacts`** — which of the synthetic session's planted facts survived into the post-compaction context.

## Parity with production

The bench does not copy the production engine configuration — it calls the same function. `compactEngineConfig()` in `src/compaction.ts` is the single source of truth, used by both the daemon's `/compact` route and the bench, and both compact against the same `COMPACT_TOKEN_BUDGET`. A change to the engine's thresholds, fan-outs, depth limits or round cap reaches the bench automatically; it cannot drift into measuring an engine production does not run.

Only two values are per-caller arguments, and the bench differs on both deliberately:

- `leafTargetTokens` — the bench passes the compiled-in `DEFAULT_LEAF_TOKENS`, not the operator's live `config.json`, so a run is reproducible across machines.
- `scrubber` — none: stored messages were already scrubbed at ingest, and the export copies stored content verbatim.

`test/compaction.test.ts` pins this: it asserts that every field except those two comes out identical for both callers.
