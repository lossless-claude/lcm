# Claude Code Hook Protocol

This document describes the stdin payload fields that Claude Code delivers to each lcm hook command.

All hooks receive a JSON object via stdin. Each hook is one CLI command:

```
lcm <hook-command> < <stdin-json>
```

## Plugin installations

When installed as a Claude Code plugin, hooks run the prebuilt bundle directly, in exec form: `.claude-plugin/plugin.json` declares `"command": "node"` with `"args": ["${CLAUDE_PLUGIN_ROOT}/bundle/lcm.js", "<hook-command>", ...]`. There is no shell and no launcher: Claude Code resolves `node`, spawns it with those arguments, and pipes the payload on stdin. The commands below are the same whichever way they are started.

A hook that cannot do its work fails open: it exits 0, prints nothing it would not print without a daemon (UserPromptSubmit still emits its learning instruction), and the first hook of the session writes one line on stderr naming the command that repairs or diagnoses it (the daemon did not start, a listener did not answer, or a newer daemon is running). A listener that holds a health probe past its deadline is starting, busy or stuck: its PID file is preserved and hooks do not spawn replacements over its port. The notice is emitted once per session. A daemon whose version is incompatible with the hook (`docs/design/self-contained-plugin.md`) makes bootstrapped hooks of that session a no-op. SessionEnd skips bootstrap and version probing to stay within its exit budget. `lcm doctor` reports the same conditions.

## PreCompact Hook

**Command:** `lcm compact --hook`

Invoked by Claude Code before it runs its built-in compaction. The daemon attempts Capture before lcm summarization and reports the two outcomes separately. A failed or unavailable Capture skips this invocation's lcm summary; a disabled or busy summarizer does not suppress the Capture attempt. The hook prints a DAG summary when one is produced, always exits `0`, and never blocks or replaces the built-in compaction. An explicit skipped summary emits empty stdout, including when Capture is unavailable, summarization is disabled or busy, or no work remains.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory of the Claude Code session |
| `hook_event_name` | string | `"PreCompact"` |

**Response:** Exit code `0`. Summary text on stdout when the daemon compacted; empty stdout to defer.

### Complete compaction context

`POST /compact` can return a complete conversation window after Capture and a summary sweep.
This opt-in daemon contract does not change the command hook's stdout or replace the harness's messages.
Send `client: "claude"`, `capture_required: true`, `render_context: true`,
`capture_through_uuid` (the engine's last model-visible append UUID), and
`context_budget_bytes` (a positive integer up to 65536). `skip_ingest` is incompatible.
The captured file must be verified through that UUID and fully consumed; an incomplete
trailing record, unverified legacy prefix or absent boundary leaves the context unavailable.

Every parsed request with `render_context: true` receives one `contextWindow` from
the typed reply constructor. Non-ready statuses distinguish `excluded`,
`no-summarizer`, `summary-failed`, `deadline`, `boundary-scan-limit`,
`capture-unverified`, `coverage-unverified`, `busy`, `empty`, `over-budget`, and
`invalid-request`. A successful Capture followed by a provider error reports
`summary-failed`; it does not invalidate the Capture result. Deadline expiry is a
warning-level outcome with the `deadline` observation code, including expiry while
reading the transcript. Cancellation and response ownership are separate: only an
actual response suppresses another reply.

A UUID behind the capture cursor is searched only in the last 1 MiB of the consumed
prefix. If that bounded window cannot establish the boundary, the daemon returns
`boundary-scan-limit` and no installable text. It does not scan unbounded history
while holding the project's mutation lease.

The additive `contextWindow` response identifies version 1, session and conversation,
byte budget, all captured source-message ids, rendered raw-message ids, each rendered
active summary's recursive source ids, and any uncovered source ids. A `ready` result
also contains fenced `text` and its UTF-8 `bytes`. Empty, busy, excluded, unverified
Capture or coverage, and over-budget results contain no installable text. A partial
window is never returned as ready. Every source message must be represented by a
whole raw item or the lineage of a rendered active summary; overlap with a retained
engine tail is allowed.

The text uses `<lcm-compaction-context version="1">` around a
`<recent-session-context>` block. Each summary begins `Summary [sum_…]:`;
raw messages retain their speaker labels. The exact generated envelope is a control
row: Capture skips it, preserving the original source messages and cursor counts,
so repeated compactions cannot capture nested copies of the generated context.
Quoted or embedded marker text remains ordinary message content.

`instructions` is an optional string of at most 50000 characters. The daemon scrubs
it with the project's rules and forwards it as operator directions to every leaf,
condensed, aggressive and fallback-provider prompt for this request. Existing
summaries are not rewritten solely to apply new directions. Invalid instruction
values are rejected with HTTP 400.

Rendered requests additionally choose `compaction_summary_model`: `pool` (default), `haiku`, `sonnet` or `session`. Non-pool choices require `summary_via_requester: true`
and a matching `requester_session_id`; `pool` uses the configured chain without
requester jobs. An `operation_id` attributes jobs and hook outcomes. The daemon's
`compaction.hookDeadlineMs` safety deadline applies to the whole rendered request;
expiry returns HTTP 408 with `contextWindow.status: "deadline"`. Summary work has one
owner under the existing session guard and project queue: concurrent same-session
sweeps wait or receive busy/skip instead of selecting the same source range.

### OMP pre-compaction and shutdown

OMP's `session_before_compact` callback awaits `/ingest` to confirm Capture, then submits an unawaited `/compact` request with `precompact_verified: true`. If another operation occupies the project's compaction queue, the daemon records a busy summary skip instead of running that summary after the native compaction window. It checks again immediately before enqueue because summarizer setup can await. OMP returns control to native compaction regardless of lcm's outcome. Its `session_shutdown` callback forces the final local observation snapshot after recording the capture attempt, even when a snapshot was written recently; `lcm doctor -v` reads that evidence when storage succeeds.

## SessionStart Hook

**Command:** `lcm restore`

Invoked at the start of a Claude Code session. lcm restores recent summaries and promoted memory, injects them as a user message prefix, and prints a `<context>` block on stdout.

On startup, resume, and clear, lcm saves a snapshot of the applicable `CLAUDE.md` files without adding another copy to the restored context. Claude Code supplies those instructions itself. After compaction, lcm replays the saved snapshot so the instructions remain available.

The snapshot reads `~/.claude/CLAUDE.md`, `CLAUDE.md` in the working directory, and `.claude/CLAUDE.md` in the working directory. If multiple paths resolve to the same file, lcm includes it only once, including when you start Claude Code in your home directory. This behavior is automatic and needs no configuration.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionStart"` |
| `source` | string (optional) | `"startup"`, `"resume"`, `"clear"`, or `"compact"`; compaction replays the saved instructions |

If `source` is missing or unrecognized, lcm uses a recent compaction mark for the same session to decide whether to replay the saved instructions. Explicit `"startup"`, `"resume"`, and `"clear"` values override that fallback; `"compact"` always requests replay. `/compact` writes the mark into the project database (`session_compactions`), so it survives a daemon restart inside the window; the window is 30 seconds. The fallback is not an edge case for the function-hooks module — `prompt.context` carries no reason for firing, so there the mark is the only thing that tells a post-compaction restore from a fresh one.

**Response:** Exit code `0`. Context is injected via stdout (printed as a `<context>` block that Claude Code prepends to the session).

Up to three recent environment rules (deterministic tool lessons) also ride in
`<learned-insights>`, one short shape line each, with counts and dates instead
of confidence labels. Restore reads the
published project snapshot; it never scans stored calls to derive lessons.
Both command and function hooks preserve those counts without inventing a confidence score.

After restore succeeds and `cwd` is present, the hook also fires one non-blocking `POST /session-start-compact` request (`{ cwd, session_id }`) to catch up conversations of the same project a previous session left uncompacted because it ended without `SessionEnd`. The daemon answers `202` at once and does the selection, exclusion and capping after the response — see `docs/configuration.md#sessionstart-catch-up-sweep` — so neither the hook nor another session's request waits on the scan; the request is never awaited.

## SessionEnd Hook

**Command:** `lcm session-end`

Invoked when the Claude Code session ends. The hook posts its stdin once to `POST /session-end` without bootstrap, a health probe or daemon spawning. It allows at most 200 ms to flush the complete request and then a 100 ms response grace, giving the handoff a 300 ms timer budget plus local startup and diagnostic work. These deadlines cancel the outstanding HTTP request; a delayed event-loop turn can increase elapsed time, so they are not a strict wall-clock bound. A `202` within the grace records `accepted` delivery in `hook-outcomes.log`; a fully written request without an answer records `submitted`, which establishes neither acceptance nor completed Capture. A refused connection exits 0 immediately and records unconfirmed delivery.

The daemon answers `202` before doing any work, then runs the ingest on its own and, once it has landed, fires compact, promote, promote-events and session-complete — only the ingest is sequenced, because the other four depend on it. The host gives SessionEnd hooks a shared budget of about 1.5s, far shorter than a large ingest, and a hook killed mid-sequence would never send the steps after the kill — so the daemon owns the sequence and the hook only hands it over. Once the complete request body has arrived, the daemon runs the sequence even if the client disconnects before the `202`; a request disconnected before its body is complete is ignored.

The daemon log records the ingest, a compact suppressed by `hooks.disableAutoCompact`, each follow-up it could not send, and each follow-up route's own outcome (see `docs/configuration.md#daemon-log`). A redaction notice (`security.notify_on_filter`) and an ingest failure are recorded through the hook error log — the events sidecar of the project when `cwd` is valid, `~/.lossless-claude/logs/events.log` only when that write is skipped or fails — not printed to the terminal. Both `hooks.disableAutoCompact` and `security.notify_on_filter` are read from the daemon's startup config, so a change in `config.json` takes effect on the next daemon start.

A compatible daemon of an earlier patch that has no `/session-end` answers `404` within the grace; the hook then runs the sequence itself, within what is left of the same 300 ms handoff budget, reading `hooks.disableAutoCompact` and `security.notify_on_filter` straight from `config.json` (not the daemon's startup config, since the hook runs this in its own process): it awaits `/ingest`, then fires compact, promote, promote-events and session-complete as the same fire-and-forget burst the daemon sends. If `/ingest` does not return within the remaining budget, the four are not sent and the timeout is logged through the hook error log and recorded as unconfirmed delivery; an HTTP rejection is recorded separately. The four follow-ups themselves are not observed, same as before this fallback existed.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionEnd"` |

**Response:** Exit code `0`. Runs best-effort; a daemon that is down, rejects or does not acknowledge in time does not block session exit.

## UserPromptSubmit Hook

**Command:** `lcm user-prompt`

Invoked on each user prompt. lcm searches memory for relevant hints and injects a `<memory-context>` block into the prompt.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `prompt` | string | The user's prompt text |
| `hook_event_name` | string | `"UserPromptSubmit"` |

**Response:** Exit code `0`. Hints are injected via stdout when relevant matches are found.

## PostToolUseFailure Hook

**Command:** `lcm post-tool` (same handler as PostToolUse)

Invoked when a tool that started running fails. Claude Code never routes failures through `PostToolUse`, so error events only exist because this hook is registered. The handler records an `error_tool` event (priority 1) in the local sidecar database. The payload carries `tool_name`, `tool_input`, a top-level `error` string (for Bash the first line is `Exit code N`), and optional `is_interrupt`; interrupts are ignored.

**Response:** Always exit code `0`, no stdout.

## PostToolUse Hook

**Command:** `lcm post-tool`

Invoked after a tool call **succeeds**, and only for the tools the `PostToolUse` matcher in `.claude-plugin/plugin.json` enumerates — the ones lcm has an extractor for. Failures arrive on [PostToolUseFailure](#posttoolusefailure-hook) instead. lcm extracts structured events (decisions, errors, git ops, etc.) and writes them to the passive-learning sidecar database.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `tool_name` | string | Name of the tool that was called |
| `tool_use_id` | string | Claude Code's id for this call; the dedup key |
| `tool_input` | object | The tool's input arguments |
| `tool_response` | any | The tool's response object |
| `tool_output` | object | Result envelope; lcm reads only `{ isError?: boolean }` |
| `hook_event_name` | string | `"PostToolUse"` |

**Response:** Always exit code `0`. This hook runs on every tool call and must be fast: it writes extracted events and a bounded outcome count to the local sidecar SQLite database, including calls whose extractor found no event. When an extracted event is priority 1 it also fires one unawaited `POST /promote-events` to the daemon, with `skip_tool_lessons: true` so per-tool promotion does not scan project calls.

## Function hooks module (early access)

**Module:** `hooks/lcm-hooks.ts`, named by `hooks/hooks.json` under `modules`. Claude Code loads it whenever its mods (function hooks) are on: by default from 2.1.287, which ignores `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`; earlier early-access builds load it only with that variable set to `1`. The command hooks above stay registered and do the work in any session the module has not claimed (see the dedup rule below).

One `tool.call` hook replaces both PostToolUse and PostToolUseFailure: it awaits the tool, reads `isError` on the result, and POSTs the same payload the command hook reads on stdin to the daemon's `POST /tool-event` route, which runs the same extractors and writes the same rows (`source_hook` is `PostToolUse` or `PostToolUseFailure` as before). The module runs in Claude Code's hooks worker with no Node and no SQLite, which is why the daemon writes. Its immediate priority-1 promotion also sets `skip_tool_lessons: true`; capture/promotion boundaries refresh lessons separately. It reads the daemon port and bearer token once per load through a host command, because `$.fs` cannot leave the project directory.

`prompt.submit` replaces UserPromptSubmit: it POSTs `/prompt-search` with `recordEvents: true` (the daemon extracts the prompt's events) and `format: "context"` (the daemon returns the rendered `<memory-context>` block), and attaches that block as hidden `context` on the prompt, which the model reads and the user never sees. The learning instruction no longer rides on every prompt: a `prompt.section` hook on the system prompt's `memory` section appends it once, cached for the session. This assumes the engine raises `prompt.section` for `memory` even when core omits the section (sections with null core text were observed firing in Claude Code 2.1.263). The module reports `learningInstructionBytes: 0` to `/prompt-search`, but the daemon's reserve is `max(reservedForLearningInstruction, learningInstructionBytes)`, so the hint budget stays what it was; the freed bytes are not spent on more hints. The module keeps a verbatim copy of `LEARNING_INSTRUCTION` from `src/guidance.ts`, as the OMP hook (`hooks/omp/lcm.ts`) does of `LEARNING_INSTRUCTION_CLI`; a test fails when either drifts.

`prompt.context` replaces the SessionStart hook's stdout: it POSTs `/restore` with `session_id` and `cwd` and appends the answer as one context block named `lcm`, leaving the engine's own blocks untouched. It fires once per conversation and again after compaction and `/clear` — the moments the command hook ran — so the restored memory arrives with the first user message rather than before it. Insights are rendered into the block exactly as the command hook printed them. A daemon that cannot answer leaves the core blocks alone.

The SessionStart hook's other half, pruning the events sidecar and promoting what a previous session left behind, moved to `POST /session-scavenge` (`{ cwd }`). `session.start` fires it and does not wait: the command hook awaited that work with the session blocked behind it. `session.start` also fires the catch-up sweep, `POST /session-start-compact` (`{ cwd, session_id }`), the same request the command hook's `restore.ts` fires after `/restore` returns.

`turn.complete` replaces the Stop hook's `session-snapshot`: at most once a minute it POSTs `/ingest` with `session_id` and `cwd` only, and `/ingest` derives the transcript file from them (`~/.claude/projects/<cwd slug>/<session_id>.jsonl`, still checked by `isSafeTranscriptPath`), then POSTs `/promote-events`. A caller that has `transcript_path` keeps sending it; the derivation is only the fallback.

Claude transcript capture checks that the resolved filename is `<session_id>.jsonl`. A subagent may also use `agent-<session_id>.jsonl` within an owning session's `subagents` tree, including workflow directories. `/ingest` rejects a mismatch with HTTP 400 before writing project storage; `/compact` uses the same check when it captures a transcript. Moving a file preserves its identity when its filename stays the same. Import, rebuild and replay use filename-derived Claude session ids, so a renamed imported file is captured under its new filename id; `source: "import"` does not bypass the check. Structured requests carrying `messages` capture those messages without reading a transcript.

The module counts operation outcomes in memory and writes bounded Session snapshots through `$.fs` at `session.start` and `turn.complete`. It alternates two `<tmpdir>/lcm-hook-observe-<safe_session_id>-<slot>.json` files so a partially written copy does not erase the last valid one. The callback waits at most 250 ms for diagnostic preparation and writing; while a write remains pending, later flushes skip instead of accumulating work. `lcm doctor -v` reads recent valid snapshots for the current project. A daemon request without an observed response is unconfirmed; an observed non-2xx response is rejected with its HTTP status. Snapshots carry counts and bounded failure codes, never prompt or tool content; an abrupt host exit can leave the last turn unflushed.

A daemon that answers 404 (an older lcm build without these routes) is logged once per route per session, not per call.

**Summarize jobs:** with `llm.provider: "session"` (see `docs/configuration.md`), the module also serves the daemon's summarization jobs for its own session. From `session.start` it holds one `GET /summarize-jobs/next?session_id=…` open (the daemon answers a job or `204` after 25 s), reading the session id again before each request, so after `/clear`, `/resume` or `/branch` it asks for the new id's jobs from the next poll on, and answers each job on `POST /summarize-jobs/:id` with `{ text, providerId, usage }` or `{ error }`. Each answer POST records accepted, rejected, or unconfirmed delivery in the Session snapshot. An unanswered fork can also carry `usageAttempts`, so its spent tokens count separately from a later fallback answer and toward the session output-token cap. Leaf jobs run `$.model.complete` with `haiku`; condensed jobs run `$.model.fork`, then `complete` when the fork does not answer. The poller stops for the session once the plugin's `sessionSummarizerMaxOutputTokens` cap is reached. A daemon that answers 404 (an older build, or a daemon swapped mid-session) does not stop it: the module logs that once and keeps polling every minute, so a later respawn with the route is picked up. Design: `docs/design/session-summarizer.md`.

Setting `LCM_SUMMARIZE_WORKER=1` before launch changes summary serving to `GET /summarize-jobs/next?worker_id=…`. Before warning or polling, the module confirms command-hook enrollment through the read-only `/worker-session` check, retrying with bounded backoff for about 30 seconds. Unconfirmed enrollment logs worker-mode refusal with its reason, then keeps checking every 5 seconds in the background without holding startup open. Worker polling begins only after enrollment is confirmed. Command-hook enrollment retries database contention up to three times and reports the underlying error. The module accepts only jobs marked `pool`, uses `complete` for both kinds, and stops polling at its per-worker cap. A 200 response without a job is an empty poll. Pool job expiry leaves worker admission intact; an abandoned enrollment with its original binding becomes active when it polls again, while finished bindings and ownerless exclusions remain refused. Pool answer delivery retries transport failures, HTTP 401, 429 and server errors up to three times, 5 seconds apart, reusing the completion and refreshing the bearer after 401. The normal mode retains the own-session rule. Worker responses and diagnostic snapshots are attributed to the worker session, while summaries remain in the source project. See [summarize workers](summarize-workers.md).

The summarizer's output budget is owned by a stable module registry keyed by
session id. It survives poller restarts and charges output before answer delivery.
The opt-in header executor shares this owner, reserves equal B/C allowances and
records fork overshoot. See
[compaction header jobs](design/compaction-header.md).

**Compaction shadow:** plugin `userConfig.compactionShadow` is boolean and defaults
to `false`. Enabling it causes substantial extra model spending, with the existing
session output cap shared by all module jobs. When off, neither shadow model calls
nor daemon shadow requests occur. When on, `session.append` observes main-session
model-visible UUIDs without changing the input or result. Only successfully stored
appends advance the boundary; pending, denied and rejected appends do not, including
overlapping completions. Clear, resume and branch reset its boundary; session end also cancels unfinished delivery ownership.

The `session.compact` observer handles real main-session `manual`, `auto` and
`plugin` cuts; `precompute`, subagent/fork `agentId` and `LCM_SUMMARIZE_WORKER=1`
sessions pass through. It freezes identity, model, instructions and original
messages, then awaits `/compaction-shadow/start` admission. A refusal or unavailable
boundary is diagnostic evidence; native still runs. One fixed 2000 ms deadline
(`SHADOW_WAIT_MS`) covers the entire admission operation: identity, cwd, model and
worker reads, host-environment/token discovery and the HTTP request. It races
with dispatch abort. Expiry starts no arms and lets native proceed; unavailability
is recorded in diagnostic counts when storage cannot be reached within that budget.
Late prerequisites cannot start a later transport stage. Foreground shadow requests
make one attempt; background arm delivery retains the ordinary transport policy.

The pending cut is registered with its captured session epoch before admission's
first await. The epoch is checked again after admission returns, synchronously
before any arm starts. Clear/end in either interval records `cancelled` and starts
no arm. When native pairing can be persisted, `native.json.shadowAdmission` records
that stage separately from native's result, usage and token counts.

A's fork starts before the
original `next(e)` is called once with unchanged input. Owned B/C tasks wait for the
frozen native-kept remainder: B uses the cut's session model, C uses `sonnet`.

After native resolves, the observer writes `/compaction-shadow/native` and returns
that same result object. This pairing operation has its own fixed 2000 ms deadline,
covering host-environment discovery and HTTP, and also races with abort. It never
waits for header models or `/arm` writes, never
installs a document, and preserves downstream rejection. Ambiguous summaries or
unmatched tails are recorded as fidelity outcomes, retaining native's known usage
and token counts even when summary/tail extraction is ambiguous. Background callbacks carry the
frozen cut identity even after the session changes. Abort/end prevent queued completions from starting. Already-running arms retain
the host's eventual outcome and usage; lost promises leave incomplete cuts. Provider
cancellation or promise survival after host unload is not guaranteed. Scheduling, actual append
flush and hook/JSONL text parity require live verification. See
[shadow artifacts](design/compaction-shadow.md) for pairing and stored fields.

**Daemon lifecycle:** the daemon exits when idle, and the command hooks bring it back through `ensureDaemon`. The module does the same when a connection is refused (the error names `ECONNREFUSED`, or a non-timeout failure came back within a second): it runs `lcm daemon start --detach` through the host (at most once per minute, with a 15s command deadline) and retries the request once. A timeout, including the module's own 500 ms `/health` deadline, is never treated as a refused connection. The module bounds `/restore` at 10s, other POST waits at 5s, and its summary-job long poll at 30s, allowing the daemon's 25s hold. It reports a non-answering listener once, leaves delivery unconfirmed, and waits for the next capture instead of starting or immediately retrying. These waits use the host clock; they do not cancel the host's outstanding fetch, which may still complete. Pool summary answers use the bounded delivery retries described above. `session.start` starts a `/health` check without awaiting it. This needs an `lcm` binary on PATH (the npm CLI); without one the module logs it once and events are lost until a command hook (SessionStart or Stop), which runs from the bundle and needs no binary, restarts the daemon.

**Dedup rule:** the module claims its session. It writes `<tmpdir>/lcm-claim-<safe_session_id>.json` containing `{ sessionId, ts }` (where `<safe_session_id>` percent-encodes the Session id, including underscores, so distinct ids keep distinct files) at `session.start`, and again in `classic.SessionStart`, `classic.UserPromptSubmit`, `classic.PostToolUse`, `classic.PostToolUseFailure` and `classic.Stop`: each awaits the write, then calls `next(e)` with the event unchanged. A hooks module runs before the command hooks of the same classic event, which run inside its `next(e)`, so the claim is milliseconds old when `lcm restore`, `lcm user-prompt`, `lcm post-tool` and `lcm session-snapshot` read it. They leave capture and context delivery to the module while that file names their session, carries no `ended`, and its `ts` is less than 60 seconds old (`CLAIM_FRESH_MS` and `functionHooksOwnSession` in `src/hooks/session-claim.ts`); command hooks that can persist diagnostics record the delegation. Otherwise every event would land twice and the model would read the memory context twice.

Only the claim says the module is live. No setting does: Claude Code 2.1.287 and later load the module without one, and mods turned off, an older build or a validation error leave nothing registered while the command hooks still run. An unreadable, absent, withdrawn or stale claim means "not mine". The claim ends two ways. At `session.end`, which fires on exit, `/clear`, `/resume` and `/branch`, the module overwrites the ending id's claim with `{ sessionId, ts, ended: <reason> }`, since `$.fs` cannot delete a file. A crash skips `session.end`, and its claim stops counting once `ts` falls outside the window. The window only has to absorb a command hook that is slow to start, so it is short: if the same session id runs again without the module inside it, its command hooks stand down until it passes. The temp file is deliberately not durable — the claim must not outlive the session.

**Session id changes:** `/clear`, `/resume` and `/branch` end one session id and continue under another without firing `session.start`. The module reads `$.session.id()` per event, so it serves the new id from the next event on, and the new id's `classic.SessionStart` (source `clear`, `resume` or `fork`) claims it before the SessionStart command hook runs. That hook therefore stands down and the module's `prompt.context` delivers the restore after `/clear`: exactly one side does, the same one that delivers it after compaction. This rests on the classic chain's order: managed settings hooks, then hooks modules, then the other settings hooks. On Claude Code 2.1.287 a plugin's command hooks are among those other settings hooks: for `SessionStart` (at startup and after `/clear`), `UserPromptSubmit`, `PostToolUse` and `Stop`, they run inside the `next(e)` of the module's `classic.*` hook for the same event.

**Dedup on the prompt's text:** a prompt has no id both paths can see — the command hook's stdin carries `prompt_id`, the module's `prompt.submit` carries only the text — so `recordUserPromptEvents` keys on `sha256(prompt)` and skips a prompt whose `(session_id, prompt_hash)` is already in the events DB (schema v5). Two identical prompts in one session collapse to one set of rows, which is right rather than lossy: the extractor is a pure function of the text, so the second set would be a copy of the first. Rows written before v5 have no hash and never dedup against.

**Dedup on the call id:** the claim only avoids the wasted work. The durable guard is `tool_use_id`, which both paths receive: `recordPostToolEvents` skips a call whose `(session_id, tool_use_id)` is already in the events DB, so a session that records twice — the claim was never written, or lapsed before a command hook read it — still stores each call once. The whole call is skipped rather than each event, because one call extracts several events. Tool event rows and their outcome observation commit together, including when the payload has no id. Rows written before schema v4 have no id and never dedup against; a payload without one is recorded as before.

**Types:** Claude Code writes the declarations of the running build beside a plugin it loads from a folder you own (`claude --plugin-dir <this checkout>`, or a folder in `CLAUDE_CODE_PLUGIN_DIRS`), at every load, under `.claude-plugin/types/`; `claude-code/index.d.ts` there is the API. Load the checkout that way again after a Claude Code update rather than editing them. `.gitignore` excludes the folder. An installed plugin's folder does not receive them (Claude Code 2.1.287). `claude plugin validate` reads the module statically: `$` may only be passed to a top-level function, and calls must be spelled `$.noun.method(...)`.

**Type-checking `hooks/` (`npm run typecheck:hooks`, not run in CI):** `scripts/typecheck-hooks.sh` compiles `hooks/lcm-hooks.ts` against `.claude-plugin/types/`, the declarations Claude Code wrote there. Those declarations are early access, gitignored, and describe whatever build wrote them — a committed copy would compile clean against an API a later release removed, which is the exact failure this check exists to catch. So it only runs locally, on demand, compared against the Claude Code build installed on the machine running it: before touching `hooks/lcm-hooks.ts`, and again after any Claude Code update. `claude plugin validate` (wired into CI, see `docs/ci-runner.md`) checks the module's structure — declared hooks, `$.noun.method(...)` call shape — but not whether a given `$` method still exists on the running build; it does not catch a renamed or removed method, and does not substitute for `typecheck:hooks`.

## SessionSnapshot Hook

**Command:** `lcm session-snapshot`

An optional periodic hook that incrementally ingests the live session transcript between `SessionEnd` events. This is used for long-running sessions where you want memory to be updated without waiting for the session to end.
An HTTP rejection leaves the retry timer eligible; it does not advance the stored transcript cursor.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `transcript_path` | string | Path to the live JSONL session transcript |
| `hook_event_name` | string | `"Stop"` (the event this hook is registered on) |

**Response:** Exit code `0`.

## Deadlines

Every hook bounds its daemon call so a wedged daemon can never hold the session open. The deadline is client-side; the host applies its own per-hook timeout on top, and the shorter of the two wins.

`ensureDaemon` uses its `spawnTimeoutMs` as one end-to-end timer budget: the initial probe, live-PID retry, restart delays and spawn wait all consume it. Each `/health` probe, including reading its response body, may use the whole remaining budget; each sleep is capped by that remainder, and expiry prevents a new spawn. Command-hook bootstrap and each hook handler allow 5s per invocation; CLI clients, daemon commands, doctor and MCP startup/recovery allow 10s. A standalone `checkDaemonHealth` defaults to the bounded `DEFAULT_HEALTH_TIMEOUT_MS` of 5s. `HEALTH_PROBE_TIMEOUT_MS` stays at 500 ms only for `noSpawn` connect-only callers. Codex Interrupt and SessionEnd use that mode without PID waiting or spawning, followed by at most 2s of requests, inside their 3s host budget. The function-hooks module's unawaited `session.start` probe also keeps its own 500 ms deadline.

SessionStart's worst-case daemon timer budget is **20s**: up to 5s for first-session bootstrap, another 5s for the restore handler's lifecycle check, then 10s for `/restore`. UserPromptSubmit allows up to **15s** (5s bootstrap + 5s lifecycle + 5s search). PreCompact skips bootstrap and allows **120s** (5s lifecycle + 115s `/compact`), within its host `timeout: 120`. A listener that never answers fails open after the remaining budget of each lifecycle invocation: at most 10s for a first-session SessionStart or UserPromptSubmit's two checks, or 5s for PreCompact, without spawning. These are timer budgets plus local process startup, file and diagnostic work; delayed event-loop turns can increase elapsed time.

A health timeout means a listener is still present, so `ensureDaemon` leaves its PID file intact and does not spawn a replacement over it. `stopDaemon` includes the initial probe and every later probe and sleep in its own `timeoutMs` budget (5s by default). With a missing or dead PID file it falls back to the port's listener PID when health answers or times out. It reports stopped only when neither a live process nor a healthy or non-answering listener remains; a timeout alone never confirms shutdown.

| Hook | Route | Client deadline | Host timeout |
|------|-------|-----------------|--------------|
| PreCompact | `/compact` | 115s for the request + up to 5s lifecycle startup = 120s — summarization calls an LLM | `timeout: 120` on the PreCompact entry in `.claude-plugin/plugin.json` |
| SessionStart | `/restore` | 10s | host default |
| SessionEnd | `/session-end` | 200 ms to flush the body, then 100 ms response grace; a 404 fallback uses the remainder of the same 300 ms timer budget | host default (SessionEnd hooks share a budget of about 1.5s) |
| UserPromptSubmit | `/prompt-search` | 5s | host default |

A request deadline plus lifecycle work longer than the host timeout is dead code — the host kills the hook first. PreCompact is the only hook that declares an explicit host `timeout`; its 115s request allowance and 5s lifecycle allowance must fit inside it.

SessionEnd skips bootstrap and connects directly, without a health probe or spawning a daemon: if none is running the hook exits 0, and the `SessionSnapshot` hook's incremental ingest, the periodic transcript scan (`docs/architecture.md#ingestion`), and the SessionStart catch-up sweep — which compacts what those already captured, never ingests itself — are the fallback.

## Auto-heal

Every lcm hook except `post-tool` self-repairs on each invocation: before dispatching, `validateAndFixHooks()` removes any lcm hook entries that leaked into `~/.claude/settings.json`. lcm hooks are owned by `.claude-plugin/plugin.json`, so a copy in `settings.json` would make every hook fire twice; a stale `lcm compact` command there is rewritten to `lcm compact --hook` instead. `post-tool` runs on every tool call and returns before this repair, deliberately, to stay inside its deadline.

## Declared worker enrollment

With `LCM_SUMMARIZE_WORKER=1`, Claude's SessionStart command hook is its sole registrar; function hooks serve jobs under that enrollment. Claude and Codex accept only `startup` or `clear` with a new session id. Resume, compact, continue and fork refuse enrollment with guidance; a resume revokes retained admission while preserving exclusion. OMP requires the native session manager to report a fresh, unpersisted session. Retained conversation content or tool events refuse enrollment without deletion. A repeated start after `/clear` revokes the preceding id owned by that hook process; exclusion of both histories remains permanent. SessionEnd marks command-hook workers finished. Registration warns that the session and its subagents are not recorded by lcm, the harness transcript stays on disk, and a dedicated session is required. An enrollment failure must prevent tool workers from receiving pool payloads. See [agent worker design](design/agent-summarize-workers.md).

Pool claim and submission routes carry `caller_session_id`, `cwd`, `client` and
`transport` beside each `worker_id`. Hook workers bind identity from their native
session API; agent adapters use Claude's `CLAUDE_CODE_SESSION_ID` or Codex shell's
`CODEX_THREAD_ID`. Codex MCP and OMP agent transports are unverified and refused.
A poll rechecks live admission immediately before release, including after waiting.
The completion deadline is `llm.poolCompletionMs`, overridden by
`LCM_POOL_COMPLETION_MS`, default 180000 ms after claim. Claude command SessionEnd and OMP shutdown mark enrollment finished; exclusion remains.
Reaching a completion allowance stops polling. A function-hook reload does not
register a new owner. Codex owners include `CODEX_THREAD_ID`, preserving admission
for another thread in the same app-server process. Enrollment is refused without
that thread id.

Command-hook worker enrollment requires a verifiable native harness ancestor
(executable name and start time). A transient shell PID is not an owner. When
ownership cannot be established, enrollment refuses with guidance. Function
hooks use `POST /worker-session` with `action: "check"`, their native session id
and cwd to confirm the command hook's live enrollment without registering an
owner. They show the exclusion warning and start worker polling only after
confirmation; otherwise they report that worker mode was refused and why.
Hook callbacks never read process arguments
or environment to identify that owner.
