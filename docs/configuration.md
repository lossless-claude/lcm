# Configuration guide

## Quick start

### Claude Code

Install the `lcm` binary and add the plugin:

```bash
npm install -g @lossless-claude/lcm  # provides the `lcm` command
claude plugin marketplace add lossless-claude/lcm
claude plugin install lcm@lossless-claude
lcm install
```

`lcm install` is the Claude Code setup path. It writes config, registers hooks, installs slash commands, registers MCP, and verifies the daemon.

#### MCP protocol revision

Claude Code opens a stdio server on the 2025-11-25 revision unless you ask it to
negotiate, and lcm serves both, so the tools work either way with nothing set. To use
the 2026-07-28 revision instead, set it in `~/.claude/settings.json`:

```json
{ "env": { "MCP_PROTOCOL_NEGOTIATION": "auto" } }
```

The variable is Claude Code's, not lcm's, and it applies to every stdio MCP server you
run. On the newer revision Claude Code asks the server what it supports before
connecting, and results carry the envelope described in
[agent-tools.md](./agent-tools.md); on the earlier one it connects directly. A server on
the newer revision cannot deliver Claude Code channel messages, so leave the variable
unset if you use lcm as a channel.

### VS Code (GitHub Copilot)

Install the repo-local connector:

```bash
npm install -g @lossless-claude/lcm
lcm connectors install github-copilot
lcm connectors doctor github-copilot
```

This writes `.agents/skills/lcm-memory/SKILL.md` in the current repository. Codex and Copilot both read that directory.

### Codex

Install the Codex connector:

```bash
npm install -g @lossless-claude/lcm
lcm connectors install codex
lcm connectors doctor codex
```

The default Codex connector writes native lifecycle hooks to `.codex/hooks.json`. Review their trust in Codex `/hooks`. Use `--global` for the user-wide configuration or `--type skill` for guidance only.

Import historical Codex sessions or replay both sources with:

```bash
lcm import --codex
lcm import --replay
```

For current limitations and the manual MCP step for Codex TOML config, see [`docs/vscode-codex.md`](vscode-codex.md).

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
```

Restart Claude Code.

## Where lcm stores things

Everything lcm owns lives under `~/.lossless-claude`: the daemon's port, token and pid, one database per project, the events sidecars, and the logs.

`LCM_HOME` moves all of it:

```bash
LCM_HOME=/tmp/lcm-sandbox lcm daemon start --detach
LCM_HOME=/tmp/lcm-sandbox claude   # the function-hooks module reads the same variable
```

Use it to run lcm against a scratch directory without touching your own memory — trying a build before installing it, or reproducing a bug on a clean slate. Moving `HOME` instead would take the host's own configuration with it, and the session would not start.

Both the daemon and the client must see the same value: a daemon started without it answers on the port from `~/.lossless-claude/config.json` and writes to the real databases.

## Daemon log

The daemon writes one JSON record per line to `~/.lossless-claude/logs/daemon.log`. Every record has `ts`, `level` and `event`; the rest are fields such as `route`, `status`, `cwd`, `session_id`, `reason` and `err`. `lcm doctor` reads it for the `daemon-log` check. To answer "why did compaction not run for this project?", filter it by `cwd`:

```bash
jq -c 'select(.cwd == "/path/to/project")' ~/.lossless-claude/logs/daemon.log*
```

- **Requests**: one `request` record per request, with its route, status and duration. `/session-end`, `/compact` and `/session-start-compact` are logged at `info`, so a `/session-end` with no `/compact` after it is visible. `/tool-event`, `/health` and `/summarize-jobs/*` are logged at `debug`. A 5xx is logged at `error`, and a 4xx at `warn`.
- **Outcomes**: `compact.done`, `compact.skipped` (`reason`: `already-compacting`, `disabled`, `no_work`, `auto-compact-disabled`), `compact.sweep`, `promote.done` and `session_end.ingested`.
- **Failures**: `route.failed`, `compact.failed`, `promote.failed`, `daemon_request.failed` (a follow-up request the daemon could not send to itself), `ingest.subagent_failed`, `daemon.crash` (with its scrubbed stack), `summarizer.fallback` (`from_provider` produced no summary, so `to_provider` summarized instead; the same endpoint at both ends when it is asked again after stopping at the output cap), and `summarizer.endpoint_unavailable` at startup, once per named endpoint left out because `missing_env` is unset.
- **Continuity**:
  - `daemon.start` records `prev`: `clean` when the previous daemon left a `daemon.stop`, `unclean` when it did not, and `none` for the first log.
  - `daemon.stop` is written on idle shutdown, SIGTERM, SIGINT and an uncaught exception. `lcm daemon stop` sends SIGTERM.
  - `log.gap` records how many records were dropped while appends were failing, and over what period.

`daemon` settings in `config.json`, read at daemon start:

| Key | Default | Effect |
|---|---|---|
| `daemon.logLevel` | `info` | Lowest level written: `debug`, `info`, `warn` or `error`. |
| `daemon.logMaxSizeMB` | `10` | When `daemon.log` would pass this size, it is renamed to `daemon.log.<timestamp>`. |
| `daemon.logRetentionDays` | `7` | Rotated files older than this are deleted. |

- **Secrets**:
  - Free-form text (messages, errors, reasons) passes through the same secret patterns as stored transcripts: gitleaks, the built-in patterns, `security.sensitivePatterns`, and the project's `sensitive-patterns.txt`.
  - Until a project's patterns are loaded, free-form text of a record naming that project is omitted, and the record carries `scrub: "pending"`. If they cannot be loaded, the record carries `scrub: "unavailable"`.
  - Identity fields (`route`, `cwd`, `session_id`) stay present so records can be filtered, and still pass through gitleaks, the built-in patterns and `security.sensitivePatterns`.
  - Request bodies are never logged.
- **Stderr**:
  - What the daemon prints outside the log goes to `logs/daemon.stderr`. This includes a crash before the log opens.
  - That file is kept across restarts. Once it is past 10 MB, it is moved to `daemon.stderr.1` at the next spawn.
- **When `lcm doctor` reports "coverage incomplete"**:
  - It does so when, in the last 24 hours, a daemon ended without `daemon.stop`, records were dropped, or the running daemon cannot write.
  - It also reports "coverage incomplete" when no daemon is running and the log, at any age, does not end on `daemon.stop`.
  - A running daemon older than the log is reported with `Fix: lcm daemon restart`.
  - It reports `0 daemon errors` only when none of these happened.
  - A daemon killed with SIGKILL, or by a power loss, also counts as ending without `daemon.stop`. So "coverage incomplete" means continuity cannot be proven, not that records were lost.
  - A daemon that could not write a single record during its whole life leaves no trace at all, because every record goes to the same disk that was failing. An example is a disk that stays full from start to exit.

## Hook outcome evidence

`lcm doctor -v` shows recent retained Hook operation counts and failure codes from active project sidecars, the current project's local command-hook log, and local snapshots. Tool capture and daemon pre-compaction outcomes aggregate in the project's events sidecar. Short-lived Claude Code command and Codex lifecycle hooks append bounded metadata to `logs/hook-outcomes.log` (rotated at 2 MB, with one retained predecessor) without loading SQLite at startup. Entries use the project hash instead of the raw working-directory path. The Claude Code function module writes alternating snapshots under the host temp directory, and OMP writes alternating snapshots under lcm's `logs/` directory. A client timeout means delivery or execution is unconfirmed, not failed. With no retained observations, verbose doctor explicitly reports unknown Hook coverage. A missing row cannot prove that the harness never invoked the hook. Abrupt exit, storage failure, or retention pruning can leave incomplete coverage.

The sidecar retains aggregated observations for seven days and at most 64 individual failure codes per Session. `doctor` reads up to seven days of the bounded command-hook log. Function and OMP snapshots bound their distinct outcome entries and individual failure codes per Session; `doctor` reads recent valid snapshots without migrating old sidecars.

## Connector scope

The connector manager can install into either the current project or your global
agent config. For Codex, the global target is `~/.codex/`. GitHub Copilot is repo-scoped in this project today.

```bash
# Install the Codex skill globally instead of into the current repo
lcm connectors install codex --global

# Inspect or remove the global connector later
lcm connectors doctor --global
lcm connectors remove codex --global
```

Use the global flag when you want Codex to pick up the connector from your
user-level config rather than a single repository checkout.

`lcm install` installs the Codex lifecycle hooks globally when `codex` is on PATH (the equivalent of `lcm connectors install codex --global`), unless it runs from the plugin bundle, where Codex is skipped with that reason. VS Code (GitHub Copilot) is not configured by `lcm install`; use `lcm connectors install github-copilot`.

## Tuning guide

The values below are read from the environment by the daemon when it starts,
and by the compaction engine it runs. After changing one, `lcm daemon restart`.
The defaults are the engine's own; leaving everything unset changes nothing.

### Context threshold

`LCM_CONTEXT_THRESHOLD` (default `0.75`) controls when compaction triggers as a fraction of the model's context window.

- **Lower values** (e.g., 0.5) trigger compaction earlier, keeping context smaller but doing more LLM calls for summarization.
- **Higher values** (e.g., 0.85) let conversations grow longer before compacting, reducing summarization cost but risking overflow with large model responses.

For most use cases, 0.75 is a good balance.

### Fresh tail count

`LCM_FRESH_TAIL_COUNT` (default `8`) is the number of most recent messages that are never compacted. These raw messages give the model immediate conversational continuity.

- **Smaller values** save context space for summaries but may lose recent nuance.
- **Larger values** (e.g., 32–64) give better continuity at the cost of a larger mandatory context floor.

### Leaf fanout

`LCM_LEAF_MIN_FANOUT` (default `3`) is the minimum number of raw messages that must be available outside the fresh tail before a leaf pass runs.

- Lower values create summaries more frequently (more, smaller summaries).
- Higher values create larger, more comprehensive summaries less often.

### Condensed fanout

`LCM_CONDENSED_MIN_FANOUT` (default `2`) controls how many same-depth summaries accumulate before they're condensed into a higher-level summary. `LCM_CONDENSED_MIN_FANOUT_HARD` (default `1`) is the relaxed minimum a hard-trigger (full) sweep uses instead.

- Lower values create deeper DAGs with more levels of abstraction.
- Higher values keep the DAG shallower but with more nodes at each level.

### Summary target tokens

`LCM_CONDENSED_TARGET_TOKENS` (default `900`) is the target size of a condensed summary.

- Larger targets preserve more detail but consume more context space.
- Smaller targets are more aggressive, losing detail faster.

The actual summary size depends on the LLM's output; the value is a guideline passed in the prompt's token target instruction.

### Prompt recall budgeting

Prompt-time recall now has a second budget layer after `/prompt-search` ranking.

- `restoration.promptSearchMaxResults` still controls how many top-ranked results the route aims to consider first.
- `restoration.promptSnippetLength` still controls the per-result snippet size before final emission.
- `restoration.maxInjectedMemoryItems` caps how many deduped hints can survive into the final `<memory-context>` block.
- `restoration.dedupMinPrefix` dedupes identical or near-identical hints by normalized prefix before emission.
- `restoration.maxInjectedMemoryBytes` caps the final prompt-time memory injection budget.
- `restoration.reservedForLearningInstruction` reserves room for `<learning-instruction>` before any hints are emitted.

In practice, the hook asks the daemon for ranked candidates, the daemon dedupes and trims them against the final byte budget, and only the emitted hints get surfaced back to the hook. That means increasing `promptSearchMaxResults` without adjusting `maxInjectedMemoryBytes` just gives the reranker more candidates to choose from; it does not guarantee more emitted context.

### Search pivot language

`search.pivotLanguage` (default `"en"`) names the language a caller translates its query into when
the project's recorded author language is a different one — the target of `lcm_search`'s optional
`pivotQuery`, not a language detected in the corpus. Change it when the text that answers queries in
your projects is predominantly in another language.

lcm never translates: the terms of `query` and of the `pivotQuery` the caller supplies are combined
additively, each under its own language's stopword pack. A pivot language other than the project's
own gets its pack ensured when the project's language is detected — generated for most languages,
already satisfied for English's built-in pack. See [search.md](./search.md) for how the pair is
prepared and where the two language names are surfaced.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

### Summary language

`summarizer.language` controls the language of newly generated summaries:

```json
{ "summarizer": { "language": "pt-BR" } }
```

When it is unset, lcm uses the project's recorded author language when one has
been detected. If neither value is available, lcm does not add a language
instruction and the model chooses as before. An explicit setting takes
precedence over the recorded project language. Values must be valid BCP 47
language tags; lcm canonicalizes common locale spellings such as `PT_br` and
rejects invalid tags.

This applies only to summaries generated after the setting takes effect.
Captured messages and existing summaries are never rewritten or regenerated.

## Model selection

LCM defaults to `LCM_SUMMARY_PROVIDER=auto`.

- In Claude sessions, `auto` resolves to `claude-process`
- In Codex sessions, `auto` resolves to `codex-process`
- In OMP sessions, `auto` resolves to `omp-process`
- In Copilot sessions, `auto` resolves to `copilot-process` — no client identifies itself as `copilot` yet, so today you select it with `LCM_SUMMARY_PROVIDER=copilot-process`
- If you explicitly set `LCM_SUMMARY_PROVIDER`, that override applies to every CLI

The provider can be pinned from the environment; the model only from `~/.lossless-claude/config.json`:

```bash
export LCM_SUMMARY_PROVIDER=anthropic
export ANTHROPIC_API_KEY=<key>     # required by the anthropic provider; `llm.apiKey` in config.json wins over it
```

```json
{ "llm": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" } }
```

Valid provider values are:

- `auto`
- `claude-process`
- `codex-process`
- `copilot-process`
- `omp-process`
- `anthropic`
- `openai`
- `disabled`
- `session` (early access, see below)

Any other value fails config load, unless it names an endpoint in `llm.providers` (see below).

`anthropic` and `openai` call their API through a client library: `@anthropic-ai/sdk` and `openai`. The `openai` provider also serves any OpenAI-compatible endpoint set in `llm.baseURL`, such as OpenRouter.
- **Plugin install:** the plugin bundle includes both libraries.
- **npm install:** the npm package lists both libraries as optional peer dependencies, so npm does not install them. A daemon started from the npm package (`lcm daemon start`, `lcm daemon restart`) needs the library for every provider it may call — `llm.provider`, `llm.fallbackProvider`, and each endpoint in `llm.fallback` — installed next to lcm. Install it, then restart the daemon so it loads the library:

  ```bash
  npm install -g openai              # or @anthropic-ai/sdk
  lcm daemon restart
  ```

  Without the library, each summarization by that provider fails with `Cannot find package 'openai'` (or `'@anthropic-ai/sdk'`), and the daemon log records it as `compact.failed`. A fallback's library is loaded only when the chain reaches it.

### Several endpoints and a fallback chain

The flat fields above (`llm.model`, `llm.baseURL`, `llm.apiKey`, `llm.reasoning`) describe one endpoint. To configure several at once — the DeepSeek API and OpenRouter, say — name each under `llm.providers`, pick the first with `llm.provider`, and list the others, in the order to try them, in `llm.fallback`:

```json
{
  "llm": {
    "provider": "session",
    "fallback": ["deepseek", "openrouter"],
    "providers": {
      "deepseek": {
        "type": "openai",
        "model": "<deepseek-model>",
        "baseURL": "https://api.deepseek.com",
        "apiKey": "${DEEPSEEK_API_KEY}",
        "body": { "thinking": { "type": "disabled" } }
      },
      "openrouter": {
        "type": "openai",
        "model": "<openrouter-model>",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "${OPENROUTER_API_KEY}",
        "body": { "reasoning": { "effort": "minimal" } }
      }
    }
  }
}
```

| Endpoint field | Applies to | Meaning |
|---|---|---|
| `type` | every endpoint | `openai` (any OpenAI-compatible server), `anthropic`, `claude-process`, `codex-process`, `copilot-process` or `omp-process` |
| `model` | every endpoint | Required for `openai` and `anthropic`. Optional for the process types, which use lcm's default for that CLI without it |
| `baseURL` | `openai`, `anthropic` | The endpoint's URL; without it, the vendor's own API. May interpolate `${NAME}` |
| `apiKey` | `openai`, `anthropic` | May interpolate an environment variable as `${NAME}`. `anthropic` without one reads `ANTHROPIC_API_KEY` |
| `body` | `openai`, `anthropic` | Extra request fields; see [Request body](#request-body) |

A process endpoint accepts only `type` and `model`: its CLI authenticates through its own login. Any other field is rejected at config load, on every endpoint.

- **Names.** An endpoint's name is what its usage is recorded under in `llm_usage_stats`, and what `llm.provider`, `llm.fallback` and `LCM_SUMMARY_PROVIDER` select it by. It is made of letters, digits, `_`, `-` and `.`; the provider values listed above are reserved.
- **Selection.** `llm.provider` names an endpoint, or `session`, `auto` or `disabled` (`auto` when unset). `llm.fallback` names endpoints only, each once. Nothing else is added: a chain whose last link fails fails the pass.
- **Selection by environment.** `LCM_SUMMARY_PROVIDER` replaces `llm.provider` and keeps `llm.fallback`; an endpoint it promotes out of `llm.fallback` still runs once. It also accepts a provider type such as `openai` when exactly one endpoint has that type.
- **Unset variables.** The daemon expands `${NAME}` from the environment of the process that started it, which may be any session's. An endpoint whose `apiKey` or `baseURL` names an unset variable (or an `anthropic` endpoint with no key and no `ANTHROPIC_API_KEY`) is left out of the chain, and the rest of the config loads; every other config error still stops the load. With every link of the chain left out, each summary fails with an error naming the endpoints and their variables. To see it: the daemon log's `summarizer.endpoint_unavailable` warning at startup, the `summarizer` field of the daemon's `/health` answer, and `lcm doctor`, which warns per endpoint left out and fails when none of the chain can run. Export the variable where the daemon starts, then run `lcm daemon restart`.
- **Both forms.** With `llm.providers`, a non-empty flat `llm.model`, `llm.baseURL` or `llm.apiKey`, and any `llm.reasoning` or `llm.fallbackProvider`, are rejected; the empty strings `lcm install` writes are ignored: each endpoint holds its own settings and inherits none from another. Without `llm.providers`, `llm.fallback` is rejected and the flat form works as described in this section.

Each link is tried once per summarization, after its own retries, plus one retry when its answer stopped at the output cap (see [Cut-off and empty answers](#cut-off-and-empty-answers)). The chain moves to the next link when the current one:

- is the session and does not answer (no module loaded, session gone, timeout, error);
- returns an answer lcm rejects (see [Cut-off and empty answers](#cut-off-and-empty-answers));
- refuses the key (401 or 403, not retried), or its account cannot pay (402, not retried);
- cannot be reached, or is still unavailable after its retries (408, 429, 5xx);
- is a process provider whose CLI run fails.

Anything else fails the pass without trying the next link: a request the endpoint refuses as invalid (400, 422) — except the retry of a cut-off answer, whose larger cap may exceed the model's output limit —, a cancelled request, a client library that is not installed, or any error lcm does not recognise. When every link fails, the pass fails with one error naming each link's failure; it never falls back to storing raw text. Every attempt is recorded under its endpoint's name, so an answer DeepSeek cut off counts as a failed `deepseek` call even when OpenRouter's answer is the one stored. An HTTP or process attempt that failed before any usage came back (a refused key, a failed CLI run) is recorded as a failed call with no tokens, and an answer that carried no usage is still attributed to the endpoint that gave it, with that endpoint's configured model. `lcm doctor` checks the CLI of every process endpoint the chain lists.

### Session provider

`llm.provider: "session"` asks the live Claude Code session that owns the transcript to run each summarization through its own client, via lcm's function-hooks module (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`; see `docs/hook-protocol.md`). Leaf chunks go to `haiku` through `$.model.complete`; condensed nodes go through `$.model.fork`, so the session's own model sees the whole conversation. Tokens are charged to the session's Claude account.

```json
{ "llm": { "provider": "session", "fallbackProvider": "claude-process" } }
```

- `llm.fallbackProvider` answers a job the session does not serve within 20 s (no module loaded, session gone, spend cap reached, an error, or an answer holding only whitespace). Any provider except `session` is valid. When absent, the `auto` resolution above applies. A provider you name explicitly in `llm.provider` is never replaced by the session path.
- With `llm.providers`, the session is the first link of the chain above and `llm.fallback` replaces `llm.fallbackProvider`; there is no implicit `auto` fallback.
- The module stops serving jobs when recorded output reaches `sessionSummarizerMaxOutputTokens`; set it in the plugin's `userConfig` (default 50000, 0 disables serving jobs). `$.model.complete` is limited to the remaining allowance, but `$.model.fork` has no output-token limit and can overshoot on its final call.
- Usage is recorded as `session:haiku` or `session:fork`; current hosts report exact `complete` usage, while older text-only results use estimated token counts recorded in `llm_usage_stats.calls_estimated`.

### Request body

A model that reasons by default can spend the whole output budget thinking. Each vendor turns that off with a request field of its own, so an `openai` or `anthropic` endpoint's `body` holds extra top-level fields sent with every request:

| Endpoint | `body` |
|---|---|
| DeepSeek API | `{ "thinking": { "type": "disabled" } }` |
| OpenRouter | `{ "reasoning": { "effort": "minimal" } }` or `{ "reasoning": { "enabled": false } }`, depending on the model |
| Qwen behind an OpenAI-compatible server (llama.cpp, MLX, vLLM) | `{ "chat_template_kwargs": { "enable_thinking": false } }` |

```json
{
  "llm": {
    "provider": "local-qwen",
    "providers": {
      "local-qwen": {
        "type": "openai",
        "model": "<qwen-model>",
        "baseURL": "http://localhost:8080/v1",
        "body": { "chat_template_kwargs": { "enable_thinking": false } }
      }
    }
  }
}
```

A body is forwarded untouched, so the accepted shape is whatever the server accepts, and config load cannot tell whether it honours a field. On OpenRouter it varies by model: GLM 5.3 Flash honours `{"effort":"minimal"}` and rejects `{"enabled":false}`; Qwen3.7 Flash honours only `{"enabled":false}`; Mercury 2.5 honours `effort`. The DeepSeek API ignores `reasoning`.

Config load rejects a body that is not a JSON object, holds a key named `__proto__`, `constructor` or `prototype` at any depth, or sets a field lcm generates: `model`, `messages`, `system`, `prompt`, `input`, `stream`, `stream_options`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `max_new_tokens`, `n`, `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `response_format`, `text` and `usage`.

In the flat form, `llm.reasoning` is the one body field there is: the `openai` provider sends it as `reasoning`, and no `reasoning` key when unset.

```json
{ "llm": { "provider": "openai", "reasoning": { "effort": "minimal" } } }
```

`llm.reasoning` is read only by the `openai` provider — `anthropic` and the
process-backed providers ignore it silently. It must be a JSON object: a string,
an array, `null` or a number is rejected at config load, not at request time.

### Cut-off and empty answers

A summary the model did not finish is never stored. When the `openai` provider's
response ends with `finish_reason: "length"`, or the `anthropic` provider's with
`stop_reason: "max_tokens"`, the answer is rejected however readable its text is:
the output budget ran out, often spent on reasoning. So is an answer from any
provider that holds only whitespace. A rejected answer moves the chain to its next
link; with none left, it fails that compaction pass (`compact.failed`, naming the
rejection): nothing from the pass is stored, and a replay leaves the session for its
next run. The call's tokens are still counted, as a failed call.

The same request stops the same way, so before moving on, an answer cut off at the
output cap is asked for once more on the same endpoint with a changed request: the
shorter (aggressive) summary prompt and twice the output cap the first answer stopped
at. A condensed summary has no shorter prompt and gets the larger cap alone. The retry
is a call of its own, counted like any other, and happens once per endpoint per chunk:
a request that already used the shorter prompt, including the compaction's own shorter
retry of a summary that did not shrink, moves on at its first length stop. If a retry
still stops at the cap, keep reasoning from spending the budget with the endpoint's
`body` (or `llm.reasoning` in the flat form).

### Token cost reporting

Every provider reports its usage in a normalized shape, stored in
`llm_usage_stats` and shown by `lcm import --replay` and `lcm stats`:

| Provider | Input | Cached | Output | Extra |
|---|---|---|---|---|
| `claude-process` | yes | yes | yes | list-price cost in USD |
| `codex-process` | yes | yes | yes | — |
| `copilot-process` | no | no | yes | premium requests |
| `omp-process` | yes | yes | yes | — |
| `openai` | yes | when the server reports it | yes | real charged cost, OpenRouter only |
| `anthropic` | yes | yes | yes | — |

The table's rows are provider types. An endpoint declared in `llm.providers` reports
what its type reports, recorded under the endpoint's name.

Every provider charges; only the Claude CLI and OpenRouter report the charge
back as a number. A missing cost therefore means *unknown*, never *free*.
Against an OpenRouter base URL the `openai` provider asks for cost accounting
explicitly, because OpenRouter omits the figure otherwise.

The reported charge is stored in `llm_usage_stats.cost_usd_total`, alongside
`calls_with_cost` — how many of the recorded calls carried a price. The column
is left NULL, and `lcm import --replay` prints `unknown`, when nothing reported
one; a partially priced run is printed as "N of M calls priced" so a partial
total cannot pass for the run's full cost.

`inputTokens` always counts the full prompt, with `cachedInputTokens` as a subset
of it, so totals are comparable across providers. The Copilot CLI only exposes
prompt-token counts in its text output mode, which hard-wraps the summary and is
therefore unusable here — it reports output tokens and GitHub premium requests
instead.

Copilot bills per request, not per token: every call costs about 0.33 premium
requests regardless of size, so a compaction over N chunks costs roughly
N × 0.33. LCM runs it with no tools, no MCP servers and no repo instructions,
which keeps the prompt around 6k tokens instead of the ~26k a default session
spends on tool schemas alone.

Using a cheaper or faster model for summarization can reduce costs, but quality matters because poor summaries compound as they are condensed into higher-level nodes.

## Stale memory review

Promoted memories stay active indefinitely unless manually archived. Over time, some become stale: old project knowledge that is no longer correct or useful, but keeps surfacing.

LCM identifies stale candidates by combining age with recall feedback signals:

- **Age threshold** (`restoration.staleAfterDays`, default 90): memories older than this are evaluated for staleness.
- **Surfacing without use** (`restoration.staleSurfacingWithoutUseLimit`, default 5): if a memory has been surfaced this many times without ever being acted upon, it is a stale candidate.
- **Restore age limit** (`restoration.restoreMaxPromotedAgeDays`, default 180): the restore route suppresses promoted memories older than this.
- **Stale penalty** (`restoration.stalePenalty`, default 0.5): score penalty applied to stale candidates during prompt-time ranking.
- **Strong match override** (`restoration.allowStaleOnStrongMatch`, default true): when enabled, stale memories can still surface if their relevance score is high enough despite the penalty.

### Inspecting stale candidates

Call the `/review-stale` daemon endpoint with `{ "cwd": "/path/to/project" }` to list stale candidates with their surfacing and usage counts across that checkout's project group. Each result includes `ownerProjectId`; pass it as `owner_project_id` with an archive or revive action to select that owning checkout unambiguously.

### Archiving and reviving

Stale candidates can be archived non-destructively. Archived memories are excluded from search and recall but remain in the database and can be revived later.

The `/review-stale` endpoint accepts `action: "archive"` or `action: "revive"` with a `target_id` to manage individual memories. It searches the caller's project group when no owner is supplied; if that ID occurs in more than one checkout, it refuses without changing either and asks for `owner_project_id` from a stats or stale result.

### Stats integration

Run `lcm stats --verbose` to see a summary of stale memory candidates across all projects.

## Votes and promotion candidates

lcm reports which memories look like rules worth enforcing structurally (a hook, a gate
check, a skill step); it never opens issues, installs hooks, or changes recall on its own —
a human reads the report and decides.

An agent reports a use of a surfaced memory with `signal:memory_used` (see
`docs/tag-schema.md`); a vote — `signal:memory_vote`, `vote:+1` or `vote:-1`, with a required
reason — adds an explicit "checked and still correct" or "checked and contradicted" signal,
distinct from mere use. See `docs/agent-tools.md` for the `lcm_store` shape and validation
rules a vote is checked against.

Use and vote signals follow their target memory to its owning checkout, so new feedback counts for a memory always come from one database. On upgrade, a historical `signal:memory_used` left in another checkout is counted once only when its target ID has exactly one active owner in the project group; an ambiguous legacy ID is not attributed. Multi-project stats identify that owner as `ownerProjectId`.

- **Enforcement threshold** (`promotion.enforcementThreshold`, default 3): a memory with at
  least this many reported uses appears under "Promotion candidates" in `lcm stats` /
  `lcm_stats`, shown with its text, owner project, use count, `+1` count and `-1` count.
  Objections are listed under "Contested".
  lcm does not classify what kind of enforcement fits; a human reads the text.
- **Contested**: any memory with at least one `-1` appears under "Contested", with every
  objection's reason and vote id, regardless of its use count.

Both sections are always shown when non-empty — not gated behind `--verbose` — since the
point is a human sees them.

Votes and use records never appear in `lcm_search` results, `lcm_grep`, or the prompt hook's
`<memory-context>` block: they exist to be counted, not recalled. Voting never changes
search ranking or which memories get injected at prompt time.

### Resolving a contested memory

A contested entry clears when the underlying question is settled, through the existing
stale-review mechanism (`/review-stale`, above) — no separate tool:

- **Archive the memory.** `POST /review-stale` with `action: "archive"` and the memory's own
  id removes it (and its votes) from every promoted-memory view.
- **Supersede it.** Store a corrected memory with `lcm_store`, then archive the old one.
- **Dismiss a single objection without touching the memory.** A `-1` vote is itself a
  promoted row with its own id, printed alongside its reason in the "Contested" section.
  `POST /review-stale` with `action: "archive"` and that vote's id archives just the
  objection; the memory stays active and the objection stops counting.


## Database management

Each project's SQLite database lives at `~/.lossless-claude/projects/<sha256-of-project-path>/db.sqlite`. The per-project path is derived automatically from the working directory.

### Inspecting the database

```bash
# Find your project hash
lcm stats

# Open the database (replace <hash> with your project hash)
sqlite3 ~/.lossless-claude/projects/<hash>/db.sqlite

# Count conversations
SELECT COUNT(*) FROM conversations;

# See context items for a conversation
SELECT * FROM context_items WHERE conversation_id = 1 ORDER BY ordinal;

# Check summary depth distribution
SELECT depth, COUNT(*) FROM summaries GROUP BY depth;

# Find large summaries
SELECT summary_id, depth, token_count FROM summaries ORDER BY token_count DESC LIMIT 10;
```

### Backup

The database is a single file per project. Back it up with:

```bash
cp ~/.lossless-claude/projects/<hash>/db.sqlite ~/.lossless-claude/projects/<hash>/db.sqlite.backup
```

Or use SQLite's online backup:

```bash
sqlite3 ~/.lossless-claude/projects/<hash>/db.sqlite ".backup /tmp/lcm-backup.sqlite"
```

## Per-agent configuration

In multi-agent Claude Code setups, each agent uses the same LCM database but has its own conversations (keyed by session ID). The plugin config applies globally; per-agent overrides use environment variables set in the agent's config.

## Disabling LCM

To fall back to Claude Code's built-in compaction:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

Or set `LCM_ENABLED=false` to make every Claude Code and Codex command hook a no-op while keeping the plugin registered.

To keep capture and recall but stop the automatic compaction at session end, set `hooks.disableAutoCompact` in `~/.lossless-claude/config.json`:

```json
{
  "hooks": { "disableAutoCompact": true }
}
```

The same flag also disables the SessionStart catch-up sweep below.

## SessionStart catch-up sweep

A session that ends without `SessionEnd` (killed terminal, crash, sleep, daemon
down at exit) still has its messages captured through the `Stop` snapshots, but
nothing summarizes them afterwards — only a manual `lcm compact --all` would.
Every SessionStart now fires a non-blocking request that catches up conversations
of the same project (`cwd`) with enough uncovered raw context to meet
`compaction.autoCompactMinTokens`, including conversations with prior summaries
and an uncovered raw tail. The most recent `LCM_FRESH_TAIL_COUNT` raw messages
are excluded from this threshold, so a conversation with only its fresh tail
left raw is not selected. It excludes the session that is starting and
conversations already compacting.

`compaction.autoCompactSessionStartMax` (default `2`) caps how many conversations
one session start requests compaction for, oldest-first; a larger backlog drains
across successive starts instead of bursting the summarizer. Set `hooks.disableAutoCompact`
to turn the sweep off entirely. The request is fire-and-forget, so session start's
latency is unaffected regardless of how large the backlog is.
