# Compare summarizer endpoints

Run the installed CLI from the project whose stored session you want to compare:

```sh
lcm eval summarizer --session <id> --models local,hosted --out ./comparison
```

`local` and `hosted` are names already declared in `llm.providers` in
`config.json`. Each candidate uses the production summarizer factory, including
its `timeoutMs`, `maxConcurrent` and `body`. It runs alone: configured fallback
endpoints and the mock summarizer are disabled for this measurement. The live
`session` provider cannot run here because this command has no session job queue.
Unknown endpoint names and missing environment variables fail before any model
call. Credentials and connection settings are not copied into the report.

The command calls your configured endpoints and incurs their normal charges.
Session text is sent to those endpoints. Both report files contain conversation
content already scrubbed at capture; keep them local and out of source control.
The command prints this notice with the output paths. It does not publish a
report or contact the daemon.

## Options

| Option | Meaning |
|---|---|
| `--session <id>` | Required stored session id. For a session with clear boundaries, use its latest conversation, as restore does. |
| `--models <endpoints>` | Required comma-separated endpoint names from `llm.providers`. Duplicates are rejected. |
| `--project <path>` | Project directory; defaults to the current directory. |
| `--runs <n>` | Positive integer repeats per session and endpoint; defaults to 1. |
| `--out <dir>` | Local directory for `report.json` and `report.html`; defaults to `summarizer-report`. Existing reports at these paths are replaced. |
| `--no-planted` | Omit the synthetic planted-facts session included by default. |

```sh
lcm eval summarizer --session <id> --models local --runs 3 --no-planted
lcm eval summarizer --session <id> --models local,hosted --project /path/to/project
lcm help eval
```

Candidates, their sessions, and repeats run sequentially. A rejected or failed
compaction is recorded as incomplete; other candidates still run. The command
writes the partial report and exits with status 1 if any run is incomplete,
otherwise 0.

## Read-only measurement

The project database is opened with `openStandaloneLcmConnection` in read-only
mode to read the session's captured messages. No project migration, capture,
summary, promotion or usage record is written. Its database file stays unchanged;
SQLite may create WAL lock sidecars while reading. The handle closes before any
model call.

Every run gets an independent in-memory SQLite database, real migrations and
stores, and the real `CompactionEngine`. It uses `compactEngineConfig` and
`COMPACT_TOKEN_BUDGET`, the same settings as the daemon's `/compact` route. The
effective summary language is `summarizer.language`, then the project's recorded
author language, or unspecified if neither is known. The resolved settings and
language are recorded. A short session can yield no calls under these production
thresholds.

## Reading the report

The JSON contains candidates, resolved settings, run results, every call's source
and output, and leaf chunks aligned by exact source text. The HTML is one
self-contained page with no external scripts, fonts or assets. It includes a
comparison table and, for every leaf chunk, a collapsed source beside each
candidate's summaries. Escalation calls remain visible, and an incomplete
candidate's missing chunk is identified.

Calls count engine summarizer invocations. Each call also records timed
provider-chain attempts, including cap retries; an adapter's internal retries
are included in its attempt's duration.

Per run, the comparison records:

- Call latency, plus prefill and decode durations where reported. OpenAI-compatible
  endpoints' `timings.prompt_ms` and `timings.predicted_ms` are recorded in
  milliseconds; unreported phase totals are `null`.
- Reported input and output tokens, including billed rejected answers and retries.
  Token totals cover reported usage; they are not estimates of unreported usage.
- Cost in USD when every observed attempt reports priced usage. An attempt with
  no usage or any unpriced usage makes the total `null`: unknown, never free.
- Cut-off answers, rejected answers, failed calls and incomplete runs. The JSON
  retains rejection reasons. Cut-off detection uses reported rejection reasons
  and, for the legacy bench metric, HTTP output-cap hits. Process adapters cannot
  always establish whether output was cut off.
- Format conformance: a `Files:` line on leaf summaries and the final
  `Expand for details about:` trailer on every summary.
- Planted facts surviving into the final compacted summaries. Incomplete runs
  have no fact-survival score because their compacted context is partial.
- Unsupported details: numbers, paths, code-shaped identifiers and quoted strings
  absent from that call's source chunk, highlighted in the HTML.

The unsupported-detail count includes numbers, quoted strings, paths with an
extension, a leading `/`, `./`, `../` or `~` (or a Windows drive prefix), or a
segment that is not a plain word, and code-shaped identifiers: underscores,
camelCase, dotted members, calls and flags such as `--no-planted`. Plain hyphenated
words and slash-joined plain words are excluded, including capitalized variants.
The count is a deterministic hint, not proof of hallucination.
It compares exact text, is case-sensitive, and counts non-overlapping occurrences.
A path or quoted span is counted once rather than counting its internal numbers
and identifiers again. Paraphrases can lose a match; continuity from the preceding
summary can introduce a detail that is absent from this source. Inspect the source
before judging the model.

The shared engine and planted-facts corpus live in `src/eval/engine.ts`; the
[developer bench](summarizer-bench.md) imports the same implementation. These
measurements can support [model certification](design/model-certification.md),
but this command does not certify or change the selected summarizer.
