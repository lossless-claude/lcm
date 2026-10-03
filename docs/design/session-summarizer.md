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
| 6 | Job timeout and fallback | A session job has 20 s to be claimed, then a fresh 60 s to be answered (`SESSION_COMPLETION_MS`). On timeout or `{error}` it delegates to the fallback provider; late answers are discarded. The completion window leaves room for a leaf answer within Claude PreCompact's 120 s outer bound, but that bound covers the whole compaction, not each job. See the bounds below. |
| 7 | Fallback provider | `llm.fallbackProvider` when set; otherwise whatever today's `auto` resolution yields for the client. Never force `claude-process`. Ordinary jobs use the configured provider; the explicit requester-first rendered-compaction override is described below. |
| 8 | Which module may serve a job | Normal `session` jobs: only the module whose `$.session.id()` equals the job's `session_id`. Explicit workers (`LCM_SUMMARIZE_WORKER=1`) instead claim only `session-pool` jobs from the shared pool. |
| 9 | Routing by node kind | leaf → `$.model.complete({ model: "haiku", system, prompt, maxTokens })`; condensed (depth ≥ 1) → `$.model.fork({ prompt })` with the rendered system + prompt as the one user message, so the model also sees the transcript. Workers use `complete` for both kinds, with Haiku by default or Sonnet explicitly selected; never `fork`. |
| 10 | Fork returns `null` (cold cache, API error) | Try `complete` with `haiku`; if that fails too, answer `{error}`. |
| 11 | Opt-in | `llm.provider: "session"`. Also accepted by `LCM_SUMMARY_PROVIDER`. |
| 12 | Spend cap | Plugin `userConfig` key `sessionSummarizerMaxOutputTokens`, default `50000`, `0` disables serving jobs. Per job `maxTokens = max(1024, 2 × targetTokens)`, computed by the daemon and carried in the job. Haiku completion is capped to the Session's remaining output tokens; a fork that spends the remainder cannot start a Haiku fallback. The host's `fork` API has no output-token limit, so the fork itself may exceed the remaining cap before its usage is reported. Cap reached → the module answers `{error: "spend cap"}`. Workers stop polling at the cap, with `LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS` overriding the plugin cap; OMP workers default to 50000. |
| 13 | Usage accounting | Into `llm_usage_stats` as today. `fork` reports exact usage; current hosts also report exact `complete` usage, while older text-only results are estimated as `ceil(len/4)`. Prior attempts carry whether they failed to answer, so a failed `session:fork` call remains separate from the successful Haiku answer in usage counters. Both attempts count toward the session output-token cap. Workers report `session-pool:haiku` or `session-pool:sonnet` usage and count failed completions toward their own cap. |
| 14 | Prompts | Rendered by the provider, in the daemon for live compaction and replay or in the eval process for isolated pool evaluation, with the same code the other providers use (`buildSummaryPrompt` / `buildSummaryPromptWithSystem`, `src/llm/prompt.ts`). The module never knows a prompt. |

## Live compaction bounds

The 60-second session completion deadline allows headroom over the roughly
23-second average Haiku leaf answer on the summarizer eval corpus. Even a claim
near the end of the 20-second window leaves about 40 seconds of Claude's
120-second PreCompact budget for other work. This is a per-job allowance, not a
guarantee that multiple chunks, capture, setup and fallback finish inside that
budget. No shorter daemon compaction deadline prevents this allowance from
helping a claimed leaf job.

| Path | Bound confirmed in code |
|---|---|
| Claude PreCompact | `.claude-plugin/plugin.json:hooks.PreCompact` sets a 120 s host timeout. `src/hooks/compact.ts:handlePreCompact` awaits `/compact` with `COMPACT_TIMEOUT_MS` (120 s), after `ensureDaemon` with a 5 s spawn allowance. The host budget covers the entire hook. |
| Hook → daemon transport | `src/daemon/client.ts:DaemonClient.rawRequest` defaults POSTs to no timeout, but applies explicit `timeoutMs` as socket inactivity timeouts and honors an abort signal. Claude PreCompact supplies 120 s. `hooks/lcm-hooks.ts:postOnce` adds no explicit timeout to host `$.http.fetch`; a host-internal HTTP cap is not established by this repository. |
| Codex PreCompact | `src/hooks/codex.ts:dispatchCodexHook` uses a 120 s abort signal and a 115 s `/compact` socket timeout. Codex has no session completion module, so extending a claimed job cannot supply a missing session worker. |
| OMP pre-compaction | `hooks/omp/lcm.ts:lcm` (`session_before_compact`) awaits capture, then submits `/compact` without waiting. `nodeTransport` retains the default 1.5 s socket timeout; disconnect does not cancel daemon compaction. OMP serves pool jobs, not ordinary session jobs. |
| Compact route and engine | `src/daemon/routes/compact.ts:createCompactHandler` awaits the project queue and `src/compaction.ts:CompactionEngine.compact`; ordinary requests have no overall wall-clock deadline, while rendered requests use `compaction.hookDeadlineMs`. Disconnect alone does not cancel ordinary work. Deadline-bound PreCompact requests skip busy project work; that admission rule remains unchanged. `src/daemon/server.ts:createDaemon` records response close without cancelling the handler. |
| Daemon lifetime | `src/daemon/server.ts:createDaemon` (`resetIdleTimer`) resets `daemon.idleTimeoutMs` on each request; its default is 30 minutes and a non-positive value disables it. Idle expiry can end the daemon even with work pending, but session polling and replies count as requests. This is a configurable daemon lifetime bound, not a per-compaction deadline. |
| SessionEnd | `src/hooks/session-end.ts:handleSessionEnd` budgets 1 s for acknowledgement (100 ms floor after elapsed work). `src/daemon/routes/session-end.ts:createSessionEndHandler` returns 202 before capture; `runPostIngestSequence` fires compaction afterwards. `runLegacyFallback` also fires compaction after bounded capture. Neither imposes a completion wait. |
| SessionStart sweep | `src/daemon/routes/session-start-compact.ts:createSessionStartCompactHandler` returns 202 before scanning and fires eligible `/compact` requests. `src/hooks/daemon-requests.ts:fireDaemonRequest` / `fireCompactRequest` set no request timeout and unref the socket after sending. `hooks/lcm-hooks.ts:registerSessionStart` submits the sweep without awaiting it. |

The outer PreCompact timeout still wins when a whole compaction takes too long;
the daemon can continue after its caller leaves. A session that has ended or a
sweep targeting an absent module still falls back after the unchanged 20-second
claim window. Increasing completion time cannot help those unclaimed jobs.

## Requester-first rendered compaction

A rendered Claude `/compact` request may explicitly select a requesting-session
summary model independently of `llm.provider`. With `summary_via_requester: true`,
matching source/requester session ids and model `haiku`, `sonnet` or `session`, the
request-local provider chain first enqueues ordinary session-owned jobs marked
`purpose: "compaction"`. These carry the chosen `model`, `operationId`, `timeoutMs`
and operation `deadlineAt`. The requesting module serves both leaf and condensed
jobs with the chosen model. The wire default is `pool`, preserving the configured pipeline and cost profile.
Opt-in Sonnet consumes Sonnet quota on every node; session-model forks also require
explicit selection.

Compaction `instructions` flow through the shared provider prompt renderer into
leaf, condensed, aggressive and configured-provider fallback prompts. The daemon
validates their length and applies project scrubbing before handing over the job.
They guide new summaries without modifying stored summaries or system instructions.

The session FIFO is separate from the worker pool. Workers cannot claim or answer
these requester jobs. An unclaimed job falls back after 20 s; a claimed job uses
`llm.poolCompletionMs`, subject to the operation's overall cancellation. Errors,
spend-cap refusal and unavailable answers also advance to the configured provider
chain. A global `session` primary is not attempted twice; its configured fallback
follows the requester. Named endpoint order and disabled fallback remain authoritative.
Late replies are discarded. Actual model usage, including prior failed attempts,
retains `session:haiku`, `session:sonnet`, `session:fork` or the answering fallback's label.

`compaction_summary_model: "pool"` bypasses requester jobs and preserves the configured
provider chain, including its worker-pool admission and fallback. Ordinary compaction,
replay and timeline routing are unaffected. The whole sweep retains the existing
session guard and yields only the project queue/mutation lease during model waits;
concurrent sweeps cannot select the same range. A later PreCompact request therefore
sees busy while the owner is in flight, or no work after the owner completed.

## Dedicated workers and replay

`session-pool` is a separate provider link, using the same rendered-prompt and
usage protocol as `session`. `SummarizeJobStore.nextWorker` claims live work first,
replay/background second and timeline last, FIFO within each class. Claims are
atomic, record one active claim per worker id, and release the claim when
it is answered or expires. Session and worker queues and waiters are disjoint.
`GET /summarize-jobs/next?worker_id=…` selects pool work; `session_id=…` retains
decision 8 for ordinary sessions. Pool jobs carry `pool: true`, which both worker
hosts validate before running a prompt. A pool job has the 20-second deadline to
be claimed, then `llm.poolCompletionMs` / `LCM_POOL_COMPLETION_MS` (default `POOL_COMPLETION_MS`, 3 minutes) to be answered: a replay chunk
takes a model longer than the 60-second live-session completion deadline. Expiry uses the same
provider-chain fallback; no persistent queue or additional endpoint semaphore is
needed, because each polling worker already serializes its calls. Timeline pool
jobs retain the reserved `lcm:project-timeline` session binding; their presence
does not extend the existing claim or completion deadlines of other jobs.

`--replay-provider session-pool` on import or batch compact sends the provider
selection on only those `/compact` requests. Hook capture paths and requests
marked `work_class: "live"` reject that selection. `--parallel N` bounds concurrent projects; `runReplayProjects` keeps
each project's ordered sessions serial. Project grouping uses the daemon's
canonical project id, so path aliases stay serialized. Import also serializes
separate host lists belonging to the same project, retaining their existing manifests and
ledger positions. The daemon project queue and per-session guard are unchanged.

Claude workers use the function-hooks `complete` operation. OMP hooks expose
`modelRegistry` credential resolution and can call the host `pi-ai.complete`
SDK, so the OMP module also serves the pool. Codex command/MCP hooks do not
expose the interactive client's isolated completion and have no worker.
Transcript persistence evidence and launch instructions are in
[summarize workers](../summarize-workers.md#transcript-hygiene-and-hosts).

## Isolated pool evaluation

`src/eval/compare.ts:runSummarizerComparison` accepts `session-pool` beside
named endpoints, while rejecting `session`. It opens the project database
read-only and closes it before any summarizer call. `src/eval/engine.ts:runEval`
keeps production compaction and all resulting summaries in an independent
in-memory database.

The transport seam is the existing provider's `enqueue` dependency, narrowed to
`Pick<SummarizeJobStore, "enqueue">` in `src/daemon/summarizer.ts:createSummarizer`.
For evaluation, that dependency posts a rendered job through `DaemonClient` to
`POST /summarize-jobs/pool`. This is smaller than moving the eval engine into the
daemon or serializing compaction context: only the job and `JobAnswer` cross the
process boundary, and prompt construction, answer validation and usage accounting
reuse the production provider. It adds one authenticated producer route;
`src/daemon/server.ts:createDaemon` applies the normal bearer authentication and
body-size limit. `src/daemon/routes/summarize-jobs.ts:createPoolSummarizeJobHandler`
validates the job, forces `pool: true`, and opens no project store.

Workers claim through the existing `nextWorker` path, with the same 20-second
claim window and 3-minute completion window. Eval supplies an isolated session
label and disables both named and flat fallback chains, irrespective of daemon
configuration. Timeout instructions name `LCM_SUMMARIZE_WORKER=1` and the worker
documentation; other candidates continue. Usage retains the answering worker's
`session-pool:<model>` label, including reported prior attempts. Live compactions
and replay still pass the daemon's real `SummarizeJobStore` directly to the
provider; their selection and fallback rules are unchanged.

## Daemon

### Provider

- `src/daemon/summarizer.ts` `createSummarizer`: new branch for `"session"`. It needs the `session_id` of the compaction in flight; thread it through `SummarizeContext` (`src/llm/types.ts`) or the summarizer factory, whichever is less invasive. `/compact` already has `session_id` (`src/daemon/routes/compact.ts`).
- `src/daemon/config.ts`: add `"session"` to the `llm.provider` union and to the `LCM_SUMMARY_PROVIDER` allowlist; add optional `llm.fallbackProvider` with the same union minus `"session"`.
- The provider function: render `system` and `prompt` exactly as `anthropic.ts` / `openai.ts` do for the same `(text, aggressive, ctx)`; compute `targetTokens` (`resolveTargetTokens`) and `maxTokens` (`resolveMaxOutputTokens`) as they do; enqueue a job; await it with a 20 s claim window and a fresh 60 s completion deadline on claim; on success return the text; on timeout or error call the fallback provider's function with the same arguments and return its result. Record usage through `ctx.onUsage` in both cases, tagging the provider id that actually answered.
- Check whether `CompactionEngine` calls `summarize` sequentially or concurrently (`src/compaction.ts`, `leafPass` / `condensedPass`). If concurrently, the queue must hold several jobs per session and the module must serve them one at a time in order.

### Job store and routes

- In-memory, in the daemon process. `Map<jobId, Job>` plus a per-session FIFO of unclaimed job ids. A job: `{ id, session_id, kind: "leaf" | "condensed", depth, system, prompt, targetTokens, maxTokens, createdAt }` — the `state: "queued" | "claimed" | "done" | "failed" | "expired"` lives on the store's internal entry beside it, and a promise resolver the provider awaits.
- `GET /summarize-jobs/next?session_id=…`: if a queued job exists for that session, claim it and answer `200 { job }` without `state`/resolver; otherwise hold the request until one appears or 25 s pass, then `204`. One waiter per session; a second waiter replaces the first (the first gets `204`). Bearer auth like every other route.
- `POST /summarize-jobs/:id` with `{ text }` or `{ error }`: resolves the provider's promise if the job is still `claimed`; a job already `expired` (the provider fell back) answers `200 { discarded: true }` and changes nothing. Body size cap like other routes. Validate that `text` is a non-empty string.
- Expire queued jobs after the 20 s claim window; reset the timer on claim to 60 s for session jobs or 3 minutes for pool jobs. Delete finished jobs after a minute.
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
- ~~`previousSummary` is dropped before it reaches any daemon provider~~ — resolved since: `SummarizeContext.previousSummary` (`src/llm/types.ts`) is rendered into the prompt as `<previous_context>`, so chunks read as one thread on every provider path.
- A disk queue for events while the daemon is down; dedup by `(session_id, tool_use_id)`.

## Constraints to keep in mind

- The module runs with no Node and no SQLite; everything goes through `$`. `$.fs` reaches only the project and temp dirs.
- Command hooks stay the path for users without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`; nothing here may change behaviour for them.
- Build in this worktree with `LCM_SKIP_CACHE_SYNC=1 npm run build` unless the installed plugin cache is meant to change.


The module keeps the session output budget in a stable owner keyed by session id,
retaining spending across poller restarts and charging before delivery. Pending
header reservations share this owner; ordinary jobs wait for them. The
[header executor](compaction-header.md) remains unwired, and does not change the
configured leaf/condensed pipeline. Module unload is not durable budget storage.
