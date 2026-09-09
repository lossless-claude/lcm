# Session summarizer: the daemon asks the live session to summarize

Status: implemented in PR #382. Builds on the function-hooks module in `hooks/lcm-hooks.ts` (PR #377).

## What it is

A daemon summarizer provider that, instead of calling an API, hands each summarization request to the Claude Code session the transcript belongs to. The session's function-hooks module runs the completion through the session's own client (`$.model.complete`, `$.model.fork`) and posts the text back. The daemon keeps every other responsibility: choosing chunks, building prompts, writing the DAG, accounting usage, falling back.

Why: it removes the `claude` CLI process spawn per chunk that `claude-process` pays inside the 120 s PreCompact window, uses the user's own credentials and model allowlist, and for condensed nodes lets the session's model see the whole conversation through the shared prompt cache.

## Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Role of OpenRouter and other providers | Unchanged. `session` is one more provider, opt-in. |
| 2 | Spending on the user's Claude plan | Accepted, with a per-session output-token cap. |
| 3 | Trigger | Unchanged: PreCompact and SessionEnd call `/compact` as today. The module never starts a compaction. |
| 4 | Integration seam | Provider seam (`LcmSummarizeFn`), not a "store a ready summary" route. The engine keeps all DAG bookkeeping. |
| 5 | Transport daemon → module | The module long-polls `GET /summarize-jobs/next`; the daemon holds the request up to 25 s. One pending request per module at a time. If `$.http.fetch` cannot hold a 25 s request, fall back to polling every 2 s. |
| 6 | Job timeout and fallback | The provider waits 20 s per job. On timeout or `{error}` it delegates to the fallback provider. A late answer is discarded. |
| 7 | Fallback provider | `llm.fallbackProvider` when set; otherwise whatever today's `auto` resolution yields for the client. Never force `claude-process`. The user's configured provider is respected always: a config that names `openai`, `anthropic`, `codex-process`, … never routes through the module. |
| 8 | Which module may serve a job | Only the module whose `$.session.id()` equals the job's `session_id`. |
| 9 | Routing by node kind | leaf → `$.model.complete({ model: "haiku", system, prompt, maxTokens })`; condensed (depth ≥ 1) → `$.model.fork({ prompt })` with the rendered system + prompt as the one user message, so the model also sees the transcript. |
| 10 | Fork returns `null` (cold cache, API error) | Try `complete` with `haiku`; if that fails too, answer `{error}`. |
| 11 | Opt-in | `llm.provider: "session"`. Also accepted by `LCM_SUMMARY_PROVIDER`. |
| 12 | Spend cap | Plugin `userConfig` key `sessionSummarizerMaxOutputTokens`, default `50000`, `0` disables serving jobs. Per job `maxTokens = max(1024, 2 × targetTokens)`, computed by the daemon and carried in the job. Cap reached → the module answers `{error: "spend cap"}`. |
| 13 | Usage accounting | Into `llm_usage_stats` as today. `fork` reports exact usage; `complete` is estimated as `ceil(len/4)` for input and output and marked estimated. `providerId` is `session:haiku` or `session:fork`. |
| 14 | Prompts | Rendered by the daemon with the same code the other providers use (`buildSummaryPrompt` / `buildSummaryPromptWithSystem`, `src/llm/prompt.ts`). The module never knows a prompt. |

## Daemon

### Provider

- `src/daemon/summarizer.ts` `createSummarizer`: new branch for `"session"`. It needs the `session_id` of the compaction in flight; thread it through `SummarizeContext` (`src/llm/types.ts`) or the summarizer factory, whichever is less invasive. `/compact` already has `session_id` (`src/daemon/routes/compact.ts`).
- `src/daemon/config.ts`: add `"session"` to the `llm.provider` union and to the `LCM_SUMMARY_PROVIDER` allowlist; add optional `llm.fallbackProvider` with the same union minus `"session"`.
- The provider function: render `system` and `prompt` exactly as `anthropic.ts` / `openai.ts` do for the same `(text, aggressive, ctx)`; compute `targetTokens` (`resolveTargetTokens`) and `maxTokens` (`resolveMaxOutputTokens`) as they do; enqueue a job; await it with a 20 s deadline; on success return the text; on timeout or error call the fallback provider's function with the same arguments and return its result. Record usage through `ctx.onUsage` in both cases, tagging the provider id that actually answered.
- Check whether `CompactionEngine` calls `summarize` sequentially or concurrently (`src/compaction.ts`, `leafPass` / `condensedPass`). If concurrently, the queue must hold several jobs per session and the module must serve them one at a time in order.

### Job store and routes

- In-memory, in the daemon process. `Map<jobId, Job>` plus a per-session FIFO of unclaimed job ids. A job: `{ id, session_id, kind: "leaf" | "condensed", depth, system, prompt, targetTokens, maxTokens, createdAt, state: "queued" | "claimed" | "done" | "failed" | "expired" }` and a promise resolver the provider awaits.
- `GET /summarize-jobs/next?session_id=…`: if a queued job exists for that session, claim it and answer `200 { job }` without `state`/resolver; otherwise hold the request until one appears or 25 s pass, then `204`. One waiter per session; a second waiter replaces the first (the first gets `204`). Bearer auth like every other route.
- `POST /summarize-jobs/:id` with `{ text }` or `{ error }`: resolves the provider's promise if the job is still `claimed`; a job already `expired` (the provider fell back) answers `200 { discarded: true }` and changes nothing. Body size cap like other routes. Validate that `text` is a non-empty string.
- Expire `queued`/`claimed` jobs at the provider's 20 s deadline; delete finished jobs after a minute.
- Register in `src/daemon/server.ts`. `GET` with a query string: the router splits on `?` already.

### Usage

- `src/daemon/routes/compact.ts` builds `summarizeWithUsage` and calls `recordCompactLlmUsage`; make sure a fallback answer is recorded under the fallback's provider id, not `session:*`. For `complete`, mark the row estimated (add a column or a flag in the existing record; prefer whatever `llm_usage_stats` already allows — inspect `src/db/*` before adding a migration).

## Module (`hooks/lcm-hooks.ts`)

- Read `options.sessionSummarizerMaxOutputTokens` from `register(on, options)`; declare it in `.claude-plugin/plugin.json` `userConfig` (default 50000). `0` → do not start the poller.
- On `session.start`: start the long-poll loop with `postDaemon`-style error handling and the existing daemon discovery (`readDaemon`, `startDaemon`). Loop: `GET /summarize-jobs/next?session_id=<$.session.id()>`; `204` → repeat; `200` → serve, `POST` the answer, repeat. Stop the loop when the module reloads (the environment is dropped; a new `session.start` starts a new one). Back off 5 s after a connection error and let `startDaemon` bring the daemon back.
- Serving: `kind === "leaf"` → `$.model.complete({ model: "haiku", system: job.system, prompt: job.prompt, maxTokens: job.maxTokens })`. `kind === "condensed"` → `$.model.fork({ prompt: job.system + "\n\n" + job.prompt })`; `null` → `complete` as above. Track output tokens spent: exact from `fork`'s `usage.output_tokens`, `ceil(text.length/4)` for `complete`; when the running total would exceed the cap, answer `{ error: "spend cap" }` and stop polling.
- Answer with `{ text }` (trimmed, non-empty) or `{ error: message }`. Include `usage` when known so the daemon can record it: `{ text, usage?: { input_tokens, output_tokens, estimated: boolean } }`.
- `claude plugin validate` rule: `$` may only be passed to top-level functions; keep helpers top-level. `$.model.complete` / `$.model.fork` must appear literally so validate lists them.
- The module has no timers other than `$.clock`; use `$.clock.after` for the back-off, not `setTimeout`, unless the generated types show `setTimeout` as a global.
- Regenerate `.claude/types/claude-code.d.ts` with `/plugin-types` before typing the new calls; `ModelCompleteRequest` and `ModelForkRequest` are documented there.

## Tests

- Provider: job created with the rendered prompt and the right `maxTokens`; answer resolves the summarize call; timeout falls back to the configured fallback and records that provider's id; a late `POST` is discarded; `{error}` falls back.
- Routes: long-poll answers `204` after the hold; a queued job is delivered once; a second waiter displaces the first; wrong `session_id` never receives another session's job; bearer required.
- Config: `"session"` accepted in file and env; `fallbackProvider` validated; `session` as fallback rejected.
- Module: `claude plugin validate .claude-plugin/plugin.json` lists `$.model.complete`, `$.model.fork`, `$.http.fetch`; typecheck against `/plugin-types` output. End to end: `LCM_SUMMARY_PROVIDER=session`, a session with the module loaded, `POST /compact` for that session; the debug log shows the job round trip and the summary lands in `summaries` with the session's `providerId` in `llm_usage_stats`. Then the same with the module absent: fallback provider answers.

## Out of scope, filed separately

- Dead config keys `compaction.leafTokens` and `compaction.maxDepth`, removed in #379. `compaction.autoCompactMinTokens` turned out to be live: `lcm compact` uses it as the threshold that picks conversations.
- `previousSummary` is dropped before it reaches any daemon provider (`SummarizeContext` has no such field), so inter-chunk continuity is lost on every provider path.
- A disk queue for events while the daemon is down; dedup by `(session_id, tool_use_id)`.

## Constraints to keep in mind

- The module runs with no Node and no SQLite; everything goes through `$`. `$.fs` reaches only the project and temp dirs.
- Command hooks stay the path for users without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`; nothing here may change behaviour for them.
- Build in this worktree with `LCM_SKIP_CACHE_SYNC=1 npm run build` unless the installed plugin cache is meant to change.
