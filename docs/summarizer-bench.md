# Summarizer eval bench

Scores a candidate summarizer model on the work lcm actually asks of it. The bench runs the real `CompactionEngine` with the production `/compact` configuration against a real session loaded into an in-memory SQLite database — real stores, real migrations — and records every summarizer call.

It is opt-in. With no `LCM_EVAL_*` variables set, only the offline tests run and no API is called.

For installed lcm users, [the summarizer comparison command](summarizer-compare.md)
runs several configured endpoints and adds a self-contained HTML view. Both use
the shared corpus, instrumentation, scoring and compaction engine in
`src/eval/engine.ts`. The developer harness keeps corpus-file loading and per-run
JSON writing under `test/bench/`.

## Running it

```bash
LCM_EVAL_MODEL=openai/gpt-oss-120b \
LCM_EVAL_CORPUS_DIR=test/bench/corpus \
LCM_EVAL_LANGUAGE=pt-BR \
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
| `LCM_EVAL_TOOL_CONTEXT` | `on` (default) supplies window pairs and block reasons; `off` runs the old-prompt baseline. Baseline result filenames include `__baseline`. |
| `LCM_EVAL_LANGUAGE` | Effective configured or detected BCP 47 language for the corpus. Omit only when production would have no known language. |
| `LCM_EVAL_REASONING` | HTTP providers: the JSON sent as `reasoning`, e.g. `{"enabled":false}`. |
| `LCM_EVAL_REASONING_EFFORT` | Shorthand for `LCM_EVAL_REASONING={"effort":"<value>"}`. |
| `LCM_EVAL_DISABLE_THINKING` | HTTP providers: `1` sends `chat_template_kwargs.enable_thinking=false`, for Qwen-style servers. |
| `LCM_EVAL_BODY` | HTTP providers: a JSON object merged into the request body after the fields above, for anything else a server needs, e.g. `{"enable_thinking":false}` for mlx-vlm. It is validated like an endpoint's `body` and is part of the run's identity. |

`openrouter` needs `OPENROUTER_API_KEY`. The provider, effective language, and
reasoning knobs are part of a run's identity and appear in the result filename,
so the same model measured under different settings does not overwrite itself.

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

Exports include each message's stored calls under `toolCalls`: call id, name,
selected input, outcome, block reason and truncation flag. Re-export old
message-only files to evaluate real failure windows. The in-memory engine loads
these calls without reading the project's lesson snapshot. Message-only corpus
files remain supported and supply no structured evidence.

Two synthetic sessions are appended: `synthetic-planted` carries the existing
facts and serves as a control without failed calls; `synthetic-tool-failures`
adds a planted error→fix pair and block reason. `LCM_EVAL_SESSIONS` can exclude
either label.

To compare the new input with its baseline on the same corpus and model:

```bash
for mode in off on; do
  LCM_EVAL_TOOL_CONTEXT="$mode" \
  LCM_EVAL_MODEL=openai/gpt-oss-120b \
  LCM_EVAL_CORPUS_DIR=test/bench/corpus \
  LCM_EVAL_RUNS=2 \
  npx vitest run --dir test test/bench/summarizer-eval.test.ts
done
```

Use the same provider and language settings for both modes. These commands
make real model calls. Compare leaf `toolPairRetention` entries and outputs in
the result JSON. A pair passes the mechanical check only when both commands
appear exactly; compressed or paraphrased pairs require human review. Control
leaf prompts must be byte for byte identical; model output can still vary
between identical requests.

## What it scores

Per run, in `totals`:

- **`formatPass` / `formatTotal`** — calls whose summary honoured the prompt contract: a `Files:` line on leaf summaries, an `Expand for details about:` trailer on all of them.
- **`maxTokensHits`** — calls whose output reached the production output cap, meaning the summary was cut off.
- **`inputTokens` / `outputTokens` / `latencyMs`** — totals across every call.
- **`costUsd`** — the charged cost when every observed attempt reports priced usage, or `null` if any attempt has no usage or any usage is unpriced. `null` means *unknown*, never *free*.
- **`failedCalls`** and the top-level `incomplete`, set when the engine itself errored. An incomplete run reports no fact survival, because chunks were left un-summarized and the score would be meaningless.
- **`plantedFacts`** — which of the synthetic session's planted facts survived into the post-compaction context.
- **`rejectedCalls` / `unsupportedDetails`** — rejected answers, including recovered retries, and non-overlapping details absent from their source. Unsupported details are a deterministic hint, not proof of hallucination.
- **`prefillMs` / `decodeMs`** — endpoint-reported phase totals in milliseconds, or `null` when unreported.

Calls retain their source text, output and all usage reports, so billed retries
remain included in token and cost totals. Leaf outputs remain visible even when
the engine later condenses them.

Each call also retains its actual `prompt`, window `toolContext`, and
`toolPairRetention` checks. The window's `toolContext.errorFixPairs` names each
failed and successful command; `toolContext.blocked` contains distinct
`{ command, reason }` entries for blocked stored calls with masked reasons.
Failures, fixes and blocks belong only to the commands they name. Structured
evidence counts as source for unsupported detail checks. A baseline still records the window's evidence for retention
scoring but excludes it from the actual model prompt. The run's
`toolContextEnabled` distinguishes the modes.

Calls count engine invocations. Their `attempts` record each provider-chain
attempt's duration, including cap retries; an adapter's internal retries are
included in that duration.

## Parity with production

The bench does not copy the production engine configuration — it calls the same function. `compactEngineConfig()` in `src/compaction.ts` is the single source of truth, used by both the daemon's `/compact` route and the bench, and both compact against the same `COMPACT_TOKEN_BUDGET`. A change to the engine's thresholds, fan-outs or depth limits reaches the bench automatically; it cannot drift into measuring an engine production does not run.

The bench passes the corpus's effective language through `LCM_EVAL_LANGUAGE`.
It deliberately passes no `scrubber`: stored messages were already scrubbed at
ingest, and the export copies stored content verbatim.

`test/compaction.test.ts` pins this: it asserts that every other field comes out identical for both callers.
