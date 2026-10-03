# @lossless-claude/lcm

## 0.15.0

### Minor Changes

- b9b1d2c: Add opt-in complete compaction windows (defaulting to the configured pipeline and cost profile) with verified transcript boundaries, exact summary coverage, strict byte budgets, generated-context capture exclusion, requester-first model jobs with configured-provider fallback, a configurable compaction deadline, and operator-instruction forwarding across summary modes.

  Requester models are optional; Sonnet for every node is an explicit quota-consuming choice. Rendered replies carry typed outcomes and UUID boundary lookups are bounded.

- 2bf587d: Derive project-scoped error→fix pairs, masked block reasons and retiring environment rules from stored shell calls. Surface counts and dates without confidence scores, refresh snapshots in bounded batches outside per-tool promotion, and classify Claude user refusal texts consistently as denied.
- 6599fe1: Add `lcm stats --warning-backtest` to replay stored shell calls offline and report point-in-time environment-rule matches, precision, coverage and would-be context cost. Pre-tool warnings remain off.
- dc8871c: Give leaf summaries bounded structured input containing their window's error→fix pairs and blocked commands with their masked reasons in the existing summary call. Preserve prompts without failure evidence and add corpus export, retention scoring and baseline evaluation support.
- b8f6f5d: Retain scrubbed tool-call inputs and result outcomes beside unchanged Claude, Codex and OMP message rows. Commands and MCP JSON are capped at 2 KB; file writes retain paths and byte size, and subagent calls retain type and description without prompts. Incremental capture updates later results, transcript event-time repair backfills existing calls, and full-text search finds stored commands.

### Patch Changes

- 186b568: Yield on a time budget while scrubbing captured message batches and string arguments, before opening the write transaction. Preserve stored text and redaction counts.
- e2600aa: Retain scrubbed, capped Codex exec script inputs and classify their first-line result status. Exclude scripts from shell-only rules and repair existing tool-call inputs and outcomes with event-time backfill.
- 0765e47: Derive deterministic tool lessons from shell commands with directory and environment
  prefixes, shell wrappers, chains and pipelines. Keep values masked and chain outcomes
  separate from their segments, and re-derive stored calls once to replace old shape keys.
- 71cb203: Preserve the deadline outcome when rendered compaction finishes reading its context after the deadline has replied. Deadline observations use the validated operation id.
- dd7ddb4: Compaction now logs `compact.failed` for a non-deadline error that follows the deadline reply.
- d8f558c: Recover from repeatedly cut summaries by halving chunks at source boundaries and using deterministic source truncation for a single message. Preserve raw sources for expansion, bound split calls by the source count, and log content-free cut diagnostics including tail repetition.
- 5d8b18c: Match Claude-Session commit trailers only against web URLs declared by main-chain transcript attachments. Capture declarations during hook capture, import and event-time backfill, and repair legacy trailer links once without changing event times or summary bounds.
- 703eb81: Bound doctor cwd checks with asynchronous stats, per-path deadlines and limited concurrency. Report timed-out and unattempted cwds as unchecked instead of missing, and continue reporting other doctor checks.
- 3cec96a: `lcm knowledge export` now scrubs with `security.sensitivePatterns` from `config.json`, as capture, import and `/store` do. Before, a value matched only by a global pattern was written to the export file in plaintext.
- 344fe39: Wait for concurrent project writes during capture and event-time backfill. Reserve migration write locks before reading, install the SQLite busy timeout before connection setup, and configure every writable project handle consistently.
- a623a38: Refresh tool lessons incrementally from changed calls and their pairing windows, re-deriving only affected sessions after deletion. Mask attached short-flag values in command shapes while retaining known value-free clusters.
- 45ba714: Record lcm throw-site frames and SQLite error codes in daemon failure logs without retaining SQLite messages, SQL parameters or external frame paths.
- c74a133: Deduplicate tool-lesson pair evaluations, cache command shapes per refresh page,
  and yield on a 10 ms work budget outside transactions while preserving resumable
  journal and snapshot publication.
- 0ca6683: Keep SessionEnd within the exit budget by submitting directly without a health probe or daemon spawn, waiting only a short response grace, and recording submitted delivery when a busy daemon has not yet acknowledged. Preserve the older-daemon fallback within the same budget.
- 1278bd1: Avoid repeated git reads during commit backfill by scanning trailer history once per session and URL per run and reusing the initial refresh of stored references.
- 7271977: Keep prompt intent labels out of passive promoted memory, deduplicate identical restored insights, and repair previously promoted passive intent labels once while preserving manual memories.
- 2c08864: Cache unchanged transcript-scan project records, remember missing metadata until
  the project directory changes, and yield on an elapsed time budget. Doctor now
  reports counts of project directories without metadata and with missing working
  directories without changing their stores.
- 3aad685: Capture now scrubs skill and slash-command arguments before storing them in `message_parts`, and counts their matches with the message's. A secret passed as an argument was redacted from the stored message but kept in plaintext in the part beside it. Rows captured before this release are not rewritten.
- de4801e: Preserve gaps in context ordinals so compaction replaces only its selected range instead of renumbering the entire conversation. Keep context order, fresh-tail selection and incremental token totals correct with sparse ordinals, without migrating existing stores.
- 40bf56b: Keep large compactions responsive with bounded database and source-preparation batches, incremental context token totals, and cached message schema checks and lookups. Preserve summary text, links and stored token accounting, including messages captured during model waits. Thread the left half's completed summary into the right half when recovering from cut answers.
- 85ba499: Report ready timeline units, months awaiting replan and parked units separately in status and doctor, using read-only indexed counts. Doctor warns about parked work and explains that a contributing session change followed by timeline settle releases it.
- 496225d: Escape `<` in the leaf summary's `tool_context` JSON so a stored command cannot close the block early, name the error when the warning backtest cannot read its store, and document the leaf evidence in the privacy notes.
- 16d628c: Yield between project-group members during prompt search, skip migration sweeps for current stores, and read recall usage feedback through an index of the requested memory ids while preserving hits and ranking.

## 0.14.0

### Minor Changes

- c84c3e7: Permanently exclude declared agent summarize worker sessions and their descendants from capture, remove provenanced captured content, and expose durable enrollment diagnostics.

  Add session-bound MCP and CLI pool workers with parallel claim ids, validated model accounting, estimated optional usage, configurable completion deadlines, and refusal of unverified harness transports.

- 587f982: Claude Code sessions captured after a compaction by an lcm earlier than the fix that stopped counting compaction's event rows may hold skipped messages and one repeated tail. Capture now checks a compacted Claude Code session's stored messages against its transcript and stops capturing it, writing nothing, when they are not the transcript's prefix. `lcm import --provider claude --rebuild` previews which compacted sessions are aligned, repairable, without a transcript, or ambiguous; with `--yes` it backs up each affected project database and rebuilds every repairable session from its transcript in one transaction, keeping the conversation, its large files and promoted memory and discarding its summaries, which `lcm compact` or `lcm import --provider claude --replay` regenerates. `--session <id>` limits it to one session. In this check, the rebuild's alignment and Codex transcript recovery, a stored `[REDACTED]` span left by a redaction pattern since removed or narrowed now matches the text it replaced, so removing a pattern no longer stalls capture.
- c8dd856: The daemon writes a log. `~/.lossless-claude/logs/daemon.log` holds one JSON record per line: every request, each compaction's outcome or reason for skipping it, summarizer fallbacks, failed follow-up requests and route errors, all scrubbed of secrets. `daemon.logLevel`, `daemon.logMaxSizeMB` and `daemon.logRetentionDays` now take effect. Output from outside the log, such as a crash before it opens, goes to `logs/daemon.stderr`. `lcm doctor` has a `daemon-log` check that counts errors from the last 24 hours, and reports "coverage incomplete" instead of "0 errors" when the log cannot prove it holds every record.
- 96ddc6b: `lcm import` imports every transcript source by default: Claude Code, Codex and OMP. It used to select only Claude Code unless `--replay` was given, so Codex and OMP sessions stayed out of memory until `--provider` was passed. Pass `--provider claude` (or `codex`, `omp`) to import one source.
- ba8c842: Several summarizer endpoints can be configured at once. `llm.providers` names each endpoint with its own `type`, `model`, `baseURL`, `apiKey` and `body`, where `apiKey` and `baseURL` both expand `${ENV}` references; `llm.provider` picks the first and `llm.fallback` lists the others in order, so the DeepSeek API and OpenRouter can be configured side by side, after the session provider or without it. The flat `llm.*` form keeps working unchanged.

  A `body` holds extra request fields for the vendor's own switches — `thinking: {type: "disabled"}` for the DeepSeek API, `reasoning` for OpenRouter, `chat_template_kwargs: {enable_thinking: false}` for Qwen behind an OpenAI-compatible server. Config load rejects a body that is not a JSON object, holds a value JSON cannot (`undefined`, `NaN`, a function, …) or a prototype key, or sets a field lcm generates (`model`, `messages`, `max_tokens`, `stream`, …).

  The chain moves to the next endpoint after a session that did not answer, a cut-off or empty answer, a refused key (401/403), or an endpoint still unavailable after its retries; a 400/422 or an unrecognised error fails the pass instead. Each endpoint runs once per summarization, and its usage is recorded under its own name: a DeepSeek answer that was cut off counts as a failed `deepseek` call even when OpenRouter's answer is stored. When every endpoint fails, the pass fails with one error naming each failure. An endpoint that failed before reporting usage (a refused key, a failed CLI run) is still counted as a failed call, and an answer that reported no usage is attributed to its endpoint and configured model. The `openai` and `anthropic` providers no longer retry a 4xx other than 408 and 429.

  An endpoint whose `${ENV}` variable is unset where the daemon started is left out of the chain rather than failing config load, so the daemon still starts and every other endpoint still runs. The daemon log warns `summarizer.endpoint_unavailable` at startup, `/health` lists the endpoints left out, and `lcm doctor` warns for each one and fails when none of the chain can run; with none left, each summary fails naming the endpoints and variables. A rejected answer names its endpoint, and the replay ledger records the model whose answer was stored.

- 77957bb: An Oh My Pi `/clear` now starts a new stored conversation under the same session id. The turns before the clear stay stored and searchable in their own conversation, and a restore after the clear returns only what followed it, or answers as for a fresh session start when nothing has been said since. Live capture, `lcm import` and archived `.jsonl.gz` sessions all split at a clear the same way. Conversations stored by earlier versions are not split. The conversation a clear closes is not compacted afterwards, and compaction sweeps no longer select it. Project databases gain a nullable `conversations.opened_by_entry_id` column the first time they are opened.

  Capture no longer counts the event rows compaction writes as stored transcript messages. After a compaction, the next capture of a Claude Code session stores the messages that follow instead of skipping one per compaction pass, and an Oh My Pi or Codex session continues from its cursor instead of failing recovery against rows its transcript never held.

- c19aaf1: OMP sessions now summarize through a `omp-process` provider that spawns the `omp` CLI itself, the same way Codex and Copilot sessions already do. `LCM_SUMMARY_PROVIDER=auto` in an OMP session now resolves to it instead of falling through to `claude-process`, which an OMP-only machine does not have. `lcm doctor` checks for the `omp` CLI the same way it checks for `codex` and `copilot`.
- cc53740: Add an opt-in incremental project timeline with immutable digest and period nodes,
  exact session coverage and attributed manual-memory claims. Enable installs tracking
  and detach triggers atomically; ordinary stores have no timeline triggers. Disable
  retains tracking, while teardown removes dependent references before triggers.
  `lcm timeline teardown --remove-nodes` also removes all owner summaries and
  node rows safely, keeping session summaries and messages intact.
  Migration restores missing tracking and detach triggers and replaces outdated SQL
  on tracked stores; doctor reports gaps read-only and names the repair command.
  Already-current migration reads before writing and completes on read-only stores
  or behind another connection's writer when no repairs or archival are needed.

  Persist metadata-only session items and month-local plans. Validate publication
  against the unit's own session counters and memory hashes in one lease, without
  replanning. Add default-off `timeline.generationEnabled`, quiet-period debounce,
  ordinary ticks that drain persisted work once generation is on, and persisted
  model-failure/publication-conflict backoff. Remove the replay completion trigger
  and unused drain flag so ledger inserts perform no timeline manifest scan. Only bounded
  named HTTP endpoints and their admitted fallbacks serve timeline generation.
  Admission failures return a configuration 4xx before database work, printed verbatim
  by the CLI, without model failure flags, backoff or parking. Require at least one
  endpoint without missing environment variables. The first admitted generation
  settle releases legacy backed-off and parked units once; legacy model failures
  also receive one retry because failure causes were not recorded. A conflicted session
  stays dirty for the next pass while other sessions and independent units continue;
  report conflict only when nothing else could proceed.

  Keep status and doctor read-only, reporting dirty sessions as well as pending and
  stale nodes. Print unavailable ordinary counts clearly and use table counts minus
  indexed owner counts. Ignore timeline consumers in orphan checks and exclude the
  owner from manual attribution. Explicit full reconciliation repairs tracking and checks conservative
  conversation aggregates. Preserve read-only access to unmigrated stores. Row locators
  and stable chunk boundaries are deferred: v1 tracks session dirt and permits repacking
  within one month. Expansion behavior is unchanged.

  A downgraded lcm promotes timeline nodes at every session end unless the nodes
  were removed first with `lcm timeline teardown --remove-nodes`. Teardown without
  the flag keeps those nodes. Re-upgrading archives those memories, matching
  `source_summary_id` against owner summaries or the reserved
  `session_id = 'lcm:project-timeline'`; such memories are never legitimate.

- 4549af7: Restore summaries with deterministic id headers and add optional `summary_id` scope to `lcm_grep`. Grep message matches name their covering summaries, and session and time filters intersect the summary scope.
- fede089: Link sessions to local commits through explicit `git commit` output or matching web-session
  trailers during event-time repair. Describe exposes commit references for sessions,
  summaries and timeline nodes. Resolved evidence anchors only unknown message times,
  with recorded provenance, using the committer date; the author date remains reference
  metadata only, and reruns correct legacy author-date commit anchors.
  Source bounds prefer known times over capture dates and condensed
  bounds read direct summary metadata rather than message subtrees. Provenance migration
  does not scan or rewrite messages. Git reads yield the project queue and mutation
  lease, writes recheck evidence, and bounds repair touches only changed conversations.
  Missing-project skips do not inflate the skipped-session count.
  The commit pass can be disabled and never fetches or stores git content.
  Hashes from viewed history, bare hex lines and hex-looking words do not establish
  commit references or event-time anchors.
- c9066ce: Allow `lcm eval summarizer --models session-pool` to compare dedicated summarize workers with named endpoints through the authenticated daemon. Evaluation keeps the project database read-only, reports usage under the answering worker's model, and fails an unavailable pool without fallback while other candidates continue.
- 23dd4c2: Add dedicated Claude Code and Oh My Pi summarize workers, a session-pool provider with bounded fallback, and replay project concurrency through --parallel. Select the pool for replay without changing the live compaction provider.
- 55f5f31: Add `lcm eval summarizer` to compare named endpoints on a stored session using production compaction in memory. Write local JSON and self-contained HTML reports with source-aligned summaries, usage, latency, rejection, format, planted-fact and unsupported-detail measurements while keeping the project database read-only.

### Patch Changes

- d6a1f3d: A summarizer endpoint that answers HTTP 402 (its account cannot pay, as OpenRouter does when the balance is exhausted) now hands the summary to the next endpoint in `llm.fallback` instead of failing the pass.
- c128a29: Back up project databases in short asynchronous steps before rebuilding Claude Code sessions, keeping the daemon responsive during large backups on Node versions that support `node:sqlite` backup.
- b482b86: Bound doctor per-store lists and orphan-summary ids to 20 entries with remaining counts. Aggregate stores without usable project records and expose complete diagnostic lists through `lcm doctor --verbose`; cleanup previews retain every candidate and skipped store. Skip orphan relationship queries when a database has no summaries.
- c079b24: Bound file-order event-time backfill work with indexed role/content and NUL-prefix matches. Historical redaction comparisons share a session-wide budget; unproven timestamps remain unknown.
- f4d098f: A full-text query now keeps at most its first 32 terms and drops terms longer than 64 characters, and a project-scoped search of promoted memory runs its full-text match once instead of once per promoted row of the project. Promotion dedup searches with a whole summary and prompt search with a whole prompt, and either could keep the daemon from answering anything for minutes. When the daemon cannot take its port because an lcm daemon that does not answer holds it, `lcm daemon start` now says so, with that daemon's pid, instead of reporting a process that is "not an lcm daemon".
- afbc462: Bound OpenAI and Anthropic summary requests with a configurable per-endpoint deadline and advance the provider chain when a request times out.
- c1c7039: Capture Claude transcripts incrementally with durable byte cursors and stored-prefix validation, including across daemon restarts. Persist tool-call model metadata with each delta so backfill no longer scans the full transcript. Preserve parser-shape, rebuild, redaction and partial-record safeguards.
- 7ca9119: Stamp Claude conversations with their parser shape. When the stamp is unknown or older, verify stored history before count-based capture and restamp aligned sessions during capture; damaged histories still require rebuild.
- 6a9bee5: Reject Claude transcript paths that do not belong to the requested session before capture, preserving filename-based import and subagent capture.
- 29ad92b: Skip Claude Code import candidates whose working directory is missing before capture or replay, and include them in the shared missing-cwd skip count. Other filesystem errors still reach the daemon.
- 58b0c05: Codex and Oh My Pi agents now receive the learning instruction on every turn, worded for the `lcm` CLI: when to store, and how to report and vote on a surfaced memory. Codex gets it at the end of the `UserPromptSubmit` context; Oh My Pi gets it appended to the system prompt. Reinstall the Oh My Pi hook with `lcm connectors install omp`.
- cab396b: Resume capture after a paginated Codex subagent rewrite whose parsed messages exactly match the stored tail, preserving stored history. Record other paginated recovery mismatches once as terminal session guards, skip later reads and report them in doctor.
- 8d8e9a9: `lcm connectors install`, `remove`, `list` and `doctor` use Oh My Pi's global config (`<agentDir>`) only with `--global`. Without it they manage the project in the current directory, including a project whose root is the home directory: `~/.omp/hooks/post/lcm.ts` and `~/.omp/mcp.json`.
- 82f04b5: Cut-row repair skips alignment when the transcript has no NUL, checks only NUL-bearing matches for repair, and avoids redaction scans when alignment can match exact or cut-prefix content.
- 5882156: When `lcm daemon start` or `lcm daemon restart` cannot reach the daemon, the message now points at `daemon.log` and `daemon.stderr` under the daemon's own home (`LCM_HOME`) instead of always naming `~/.lossless-claude/logs`.
- 3213007: `lcm doctor` reports Claude Code transcripts that lossless memory never stored (`claude-capture`, category `Capture`): for every project lcm tracks, and for the current directory's project, the number of transcripts whose session has no stored message and was not completed since the file last changed, the most recent one's path, and the fix, `lcm import --provider claude` in that project. It never reads a transcript, only its file status, and opens each project database read-only; it leaves out transcripts modified in the last 15 minutes, whose session may still be running. A session captured only in part is not reported.
- e09e06a: Named OpenAI and Anthropic endpoints can limit simultaneous HTTP summaries with `maxConcurrent`. Calls beyond the limit wait in daemon-wide FIFO order, with a separate bound for the slot wait and a fresh request deadline after admission.
- 69323df: `lcm_expand` on a condensed summary now descends into the summaries it was condensed from. It used to follow the edge the other way, returning the summaries that had consumed it — usually none for a top-level summary — so expanding a condensed summary showed nothing beneath it. `lcm_describe` had the same inversion in its `subtree` and `childCount`: they now list and count the summaries a condensed summary was condensed from.
- 93bd960: `POST /compact` no longer answers 500 when a compaction leaves the context larger than it found it. The completion banner's savings bar clamps to its width instead of throwing on a negative repeat count, and reports "grew" with an honest percentage and token delta instead of a false "saved"/"compression" figure.
- c41ce7f: Classify compacted Claude Code sessions against current and older tool shapes so mixed histories can be rebuilt in today's shape. Capture stalls on a mismatched prefix, and the periodic scan skips unchanged transcript failures.
- 5e1cccb: `lcm doctor` checks the memory guidance each installed harness receives. With `codex` on PATH it warns when the Codex hooks are missing and reports whether the MCP server is registered; with `omp` on PATH it warns when the Oh My Pi hook or MCP server is missing. `lcm doctor` and `lcm connectors doctor omp` also report an Oh My Pi hook that differs from the one this version ships, since the installed hook is a copy that an upgrade does not change.
- f45fc38: Function hooks defer timed-out daemon requests without starting a second daemon or retrying immediately.
- 59749c8: Skip a verified OMP pre-compaction summary when another project operation is already queued, persist the final OMP shutdown observation, and index retained hook failure timestamps for pruning.
- 2640383: Automatically promote insights for projects compacted by import replay, with a `--no-promote` opt-out. Document `lcm promote --all` for catching up existing summaries without replay.
- 456230b: Index foreign key child columns used when deleting messages and summaries, so SQLite can check dependent rows without scanning their tables.
- a0b7431: The `lcm-memory` connector skill now says when to use it in its description, states the search-then-store flow once, and carries the same guidance as the rules files, including how to report and vote on a surfaced memory. Reinstall it with `lcm connectors install <agent> --type skill`.
- 63c0c96: Admit live session compactions before queued background replay work at named HTTP endpoints, preserving FIFO within each class. Background slot waits no longer time out; live slot waits and each admitted HTTP request retain their configured deadline.
- c4ffe16: Add preview-first manual memory session attribution repair to `lcm doctor`. Match
  raw Claude and Codex store calls, leave ambiguous and unmatched memories alone,
  and require explicit offline apply with a database backup to update only session ids.
- de13e6d: Consolidate MCP tool definitions and routing in one catalog, and return the normal unknown-tool error for names inherited from JavaScript objects.
- 712bf03: Preserve transcript message text after NUL characters in capture and repair older cut rows during Claude session rebuilds.
- 5ec918e: `lcm import --omp` now discovers and imports archived `.jsonl.gz` OMP sessions (written by `omp gc --apply`), alongside live `.jsonl` files. An archive is read in full on every import, with no resume checkpoint; a repeated import stays idempotent through the same already-stored check every source uses. When a live file and an archived copy exist for the same session id, the live file wins.
- 14a9f89: Oh My Pi capture and `lcm import --omp` follow the session's live path. An OMP session file is an append-only tree; lcm now keeps only the entries on the `parentId` chain from the file's last entry, as OMP does when it resumes a session, so a turn abandoned by a rewind or branch switch before it was captured is no longer stored. A turn already captured before the rewind stays in memory. A recovery scan of an OMP transcript continues the live path when stored history is a prefix of it, and otherwise accepts stored history that holds the file's messages in order without being a prefix of them, instead of refusing a session that was rewound.
- 9c316c5: Oh My Pi agents can call lcm's MCP tools. `lcm connectors install omp --type mcp` adds the lcm server to `.omp/mcp.json`, or to `<agentDir>/mcp.json` with `--global`, and `lcm install` run from the npm CLI registers it globally next to the hook.

  `lcm connectors install <agent> --type mcp` no longer replaces a config file that is not valid JSON, which dropped the servers it held; it stops and names the file. It also refuses to run from the Claude Code plugin, whose CLI path the next plugin update deletes.

- 75a99fb: `lcm import` (all providers that include OMP) now discovers sessions under every OMP profile (`~/.omp/profiles/<name>/agent/sessions`), not only the active agent directory. A profile reached through a symlinked directory is not scanned. A session id found in several roots is imported once (live over archived, else newest, else the active root's copy), and each skipped copy is listed in the import result. `lcm import --provider omp`/`--omp` now also reports every root it scanned, so a "0 sessions" result names where discovery looked.
- 34fad03: The memory guidance (`~/.claude/lcm.md`, the learning instruction, connector rules and the `lcm_store` description) now comes from one source and says the same thing everywhere: the same seven store types, the same tag advice, and search before grep for broad recall. The `lcm_store` tags description now names the reserved `signal:` tags. `lcm doctor` rewrites an existing `~/.claude/lcm.md` to the new text.
- 09e4f7a: A summary cut off at the output cap (`finish_reason: "length"`, or Anthropic's `stop_reason: "max_tokens"`) is now asked for once more on the same endpoint before the chain moves on, with twice the output cap. A leaf summary also switches to the shorter prompt; condensed and task summaries keep theirs. Before, the next endpoint got the same request, so a chunk every endpoint cut off failed the compaction on every run. The cut-off answer is still never stored and still counts as a failed call.
- 0a75d9b: Give every passive promotion a mapped `type:` tag so type filters can find it. Normalize legacy string-tag encodings and passive category tags on database migration, preserving existing types and archived status. Reject malformed tags at the promoted-memory writer; knowledge import decodes the same legacy encodings, so an earlier export still imports.
- 621eef9: Keep live summarize workers admitted after pool job expiry and restore valid abandoned bindings on polling. Release undelivered claims on failure, handle empty hook polls quietly, retry worker enrollment contention and delayed confirmation, and retry transient pool answer delivery without repeating completion. Permanent capture exclusion stays intact.
- dc5ef4c: Persist successful transcript scan fingerprints in each project's sidecar so daemon restarts skip unchanged transcripts. Yield between transcripts within one project to keep the daemon responsive during large scans.
- ed1954d: Claude Code and Codex PreCompact hooks now have the daemon attempt transcript capture before lcm summarization. OMP retains its bounded capture request and submits lcm summarization only after Capture is confirmed. A failed or unconfirmed capture skips only lcm's summary while native compaction continues. The Stop hook keeps its retry timer eligible after an HTTP rejection. Active hook paths retain bounded operation counts and failure codes that `lcm doctor -v` can inspect without requiring the daemon to be running. The Claude Code function module accepts the current host model-result shape and accounts for usage from unanswered attempts before fallback.
- 9871a15: Preserve existing history when worker ancestry or copied claims refuse capture; only descendants discovered under an enrolled worker's native transcript directory permit cleanup. Refuse Codex worker enrollment without a thread id, confirm command-hook enrollment before function hooks warn or poll, and shorten worker ids in MCP stats. Document shared-owner revocation for nested Claude workers.
- 8957d56: Write project records before passive event promotion, restore, summary promotion and portable knowledge import open their stores. Keep explicit store project ids as row provenance in the cwd's store.

  Report record-less store counts and whether they hold promoted memories in doctor. Offer cwd recovery suggestions from structured row evidence in cleanup preview, preserving these stores and their event sidecars for manual review.

- 13191a6: The daemon keeps answering while `/promote` and `/promote-events` work through a large backlog: both yield to the event loop between items and hold the project's mutation lease, so two runs for one project no longer promote the same summaries or events twice. The daemon log records `daemon.stalled` after the event loop was blocked for more than 5 seconds, naming the requests that were in flight, and `request.start` at `debug`.
- 5a0ea42: Use a buffered Node HTTP transport for OpenAI and Anthropic summarizers so response headers and bodies can take longer than 300 seconds, bounded by the configured request deadline. Preserve Node's default HTTPS certificate trust, including private CAs supplied through NODE_EXTRA_CA_CERTS. Proxy routing is not supported by this transport.
- fc86f06: Memoize validated Claude transcript prefixes so compacted sessions compare only newly stored overlap while unchanged prefix fingerprints still match. Revalidate after identity, history, or redaction changes, and retain the rebuild error for damaged sessions. `daemon.stalled` no longer names a request or background task that ended before the block began, and names the tool-call model backfill `/ingest` runs after replying as `ingest:backfill`.
- 27ea706: Skip unchanged subagent transcript guard failures during repeated capture and report stalled subagent sessions in doctor.
- 3f1c146: Link session trailer evidence once per session and commit without dating its messages. Anchor unknown event times only from a single distinct, resolvable commit output, and repair legacy duplicate links and guessed anchors while preserving summary text.
- 6fcf4f3: Exclude plain hyphenated and slash-joined prose from unsupported-detail hints in summarizer comparisons, while retaining code-shaped and factual details.
- 8ce21aa: Skip transcript scan requests for vanished working directories and report skipped sessions in one debug entry per scan. Capture resumes when the directory returns.

  Skip Codex and OMP sessions with missing working directories before import or replay sends requests to the daemon. Check each distinct cwd once per import run and report skipped sessions in one `Skipped (cwd missing): N` summary line. Keep daemon cwd validation unchanged.

- 34714a6: Keep the newest completed rebuild backup and the oldest one (the database before any rebuild) per project, remove and report the copies in between, and show remaining backup sizes in doctor.
- 48ba393: A summary the model did not finish is no longer stored. An `openai` response that stopped at `finish_reason: "length"`, an `anthropic` response that stopped at `stop_reason: "max_tokens"`, and any provider's answer holding only whitespace are rejected: the compaction pass fails with `compact.failed` naming the rejection, stores nothing and leaves context unchanged, and a replay retries the session on its next run instead of recording it as compacted. A rejected answer is never replaced by the truncated-source fallback. A length stop is not retried against the same endpoint. The rejected call's tokens are still counted in `llm_usage_stats`, as a failed call, and a session answer that was rejected, or abandoned for `llm.fallbackProvider`, is counted as failed rather than sharing the fallback's success.
- 7ff99c2: Remove the unused hard-trigger compaction setting and use the shared fanout defaults of 3 and 2 for invalid values instead of the stale 8 and 4 fallbacks. Clarify expansion token-cap support and the uncapped daemon path.
- 78a8246: User prompts no longer produce a `user_decision` event. It fired on English keywords such as "always" or "never", missed every decision on a non-English corpus, and still promoted what it matched into memory. Decisions answered through `AskUserQuestion` are still recorded. Store a lasting decision with `lcm_store` and a `type:decision` tag.
- 6b8ff54: Repair historical Codex and OMP message rows cut at NUL with a preview, backup, and full-text index update.
- e799364: Claude session rebuild can repair conversations captured before role tagging when every stored message remains in the transcript. It compares their content across the current and older tool-content parser shapes regardless of role, then stores today's shape and parser stamp.
- 1990ca7: `lcm import --replay` and `lcm compact --replay` stop the run when the daemon becomes unreachable, instead of marking every remaining session failed and breaking each one's replay chain. This also covers a daemon that is alive but wedged: a mid-flight socket drop now gets a quick health probe before deciding — a healthy answer keeps today's behaviour (retry/skip that one session), no answer stops the run the same way a refused connection does. Nothing is recorded for the session in flight — no ledger row, no chain reset — so rerunning the same command resumes exactly where it stopped.
- 531b696: Route replay restart resets through the daemon's session compaction guard, project queue and mutation lease so an in-flight summary cannot outlive the reset.
- fe607c8: A Claude Code session resumed after it ended (`claude --resume`) is captured again. Resuming appends to the same transcript file under the same session id, but once a session was recorded complete every later capture skipped it, so the turns after the resume were never stored. Capture and `lcm import` now skip a completed session only while its transcript has not been modified since it was completed, and ending the resumed session records the new completion time.
- 8347b57: Preserve existing conversations when worker enrollment is refused, restrict enrollment to fresh starts, and ignore wire-supplied recovery markers. Keep lifecycle owners stable across Claude function-hook reloads and independent across Codex threads. Frame MCP and CLI jobs as untrusted data, shorten diagnostic worker ids, recognize copied claims through absolute CLI paths, and return undelivered claims to the queue.
- aa4d636: The periodic transcript scan (every 10 minutes) no longer walks every project directory synchronously: it reads directories with `fs/promises` and yields to the event loop every 50 projects, so a store with tens of thousands of projects no longer blocks the daemon for seconds at a time. The scan and the ingest behind `/session-end` are now named in `daemon.stalled` records (`scan:transcripts`, `session-end:ingest`) when a stall happens during either, instead of blaming whatever HTTP request happened to be in flight. `GET /summarize-jobs/next`, a long poll that is always in flight by design, is no longer named as a cause of a stall; `daemon.stalled` now carries a `longPollCount` field instead of one record per pending long poll.

  The scan also no longer re-parses a transcript it already ingested successfully and that has not changed since: it keeps an in-memory fingerprint per transcript path (the parent file's size and mtime, plus the same for every subagent transcript and `.meta.json` sidecar under its `subagents/` tree, since subagents grow and get their attribution through the parent's own `/ingest` while the parent file may not change) and skips the `/ingest` call when the fingerprint is unchanged. A failed ingest is never recorded, nor is one whose subagent capture or tool-call model backfill failed (`/ingest` now answers `200` with `incomplete: true` when a subagent capture fails, and, for the scan, which asks it to run the backfill before replying, when the backfill fails), so it is retried on the next pass, and a transcript no longer on disk is dropped from the cache. Concurrent passes never overlap: a pass still running when the next scheduled tick fires is skipped.

- fa3b0f3: On Claude Code 2.1.287 and later, which load the function-hooks module by default, exactly one path now captures events and delivers memory per session: the command hooks stand down whenever the module has claimed the session, with or without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`. The module rewrites its claim before each command hook that reads it runs, withdraws it at `session.end`, and a claim older than 60 seconds no longer counts, so a session where the module did not load, including one resumed after a crash, keeps the command hooks working. After `/clear`, `/resume` or `/branch` the module claims the new session id too, so the restored memory reaches the model once instead of twice.
- baa33d7: Give claimed session summarization jobs 60 seconds to answer while retaining the 20-second claim window, so slow leaf answers are accepted before fallback.
- b3cd5a5: Index conversation session IDs so session message lookups search the matching conversations before reading their messages.
- b447b57: The function-hooks module (`llm.provider: "session"`) no longer throws when the host answers a summarize job with a non-string `text`. `model.complete` and `model.fork` results are treated as unanswered in that case, with a reason naming the host call, instead of crashing with `text.trim is not a function`; usage from the failed attempt is still reported.
- 3d60a88: Report function-hook snapshot write failures only when the host write fails, including failures after the bounded wait. Slow successful writes no longer report a failure.
- 733bc66: Exclude requests and background tasks that start after a reported event-loop stall's end bound from `daemon.stalled` attribution.
- 519ba69: Record harness session identity for MCP and CLI memory stores and default project provenance to the destination database, preserving explicit metadata overrides.
- ec07ebf: Summary depth and metadata backfills run once per database, and again when their columns are added, instead of recomputing summaries on every migration sweep. New summaries continue to receive these fields when inserted.
- 8749f46: Give every summary a unique id. Two summaries with identical text created in the same millisecond used to get the same id, and the compaction failed with `UNIQUE constraint failed: summaries.summary_id`.
- d95cb83: A memory promoted from a summary records that summary's id, deduplication keeps the canonical provenance, and a summary is not promoted twice: it is recognised by its id, or, for memories promoted before this change, by the earlier content-prefix rule.
- 221cb59: Version terminal Codex transcript recovery guards so recovery-rule changes retry older failures once. Add `lcm import --provider codex --retry-blocked` to clear guards without changing stored history: the current project by default, one current-project session with `--session <id>`, or every recorded project with `--all`. Name the remedy in doctor diagnostics.
- bff59ed: Report missing temporary or test project stores and orphan summaries in doctor. Add a dry-run-first, explicit cleanup that moves stale stores and event sidecars to lcm's trash and removes their group-index references while the daemon is held offline. Guard test home resolution against the OS user's real lcm home, including child processes and symlink aliases.
- 6d1e1c8: Prioritize worker-pool jobs as live compaction, replay/background, then timeline, preserving FIFO within each class and existing deadlines. Allow project timeline generation through session-pool when every fallback also enforces this order.

  Treat unclaimed timeline pool jobs as busy without failure flags, backoff or parking; claimed completion timeouts still count as model failures.

- 14b3cb2: Preserve transcript event timestamps separately from capture time across Claude Code, Codex and OMP capture, import and rebuild. Add resumable `lcm import --backfill-event-times` repair, recompute summary and explicitly requested conversation source bounds, and place timeline periods by event time with explicit capture-time fallback metadata. Keep conversation reads free of message scans, page repairs through sequence and depth/id indexes, and preserve read-only rebuild previews on unmigrated stores. Automatic ticks resume tracked timeline bootstrap in bounded pages after an upgrade.

  The timeline prompt revision makes every active tracked timeline node stale. The first settle after upgrade replans the timeline; generation regenerates those nodes with model calls within the requested call budget (or one unit per automatic tick). Metadata-only settles make no model calls.

- c0b66ce: Refuse request-supplied worker ancestry without persisting exclusion, retry function-hook enrollment confirmation, and keep directory discovery outside capture transactions. Record verified descendants for database-only capture gates and report copied successful claims in doctor while preserving retained history. A copied claim counts only when its result carries a job id the daemon issued, so refused claims, bare invocations and output merely shaped like a job leave ordinary sessions capturable.
- 5921ff4: Compaction yields its project queue turn during external model calls, allowing captures of the same project to finish while a summary is in progress. Database mutation remains serialized by the project lease. Another session's PreCompact can run while a summary waits on its model; an active queue turn, outstanding mutation lease, or compaction of the same session still makes it busy. Direct compactions of the same project session wait for the active request to finish; `skip_ingest` callers retain their busy/skip outcome.

## 0.13.0

### Minor Changes

- c30bdb5: feat: one tool vocabulary every harness translates onto, so no harness's tools raise nothing

  Passive learning keyed on Claude Code's tool names, and each harness carried its own bespoke
  renamer: `normalizeCodexTool` translated two Codex ids, the Oh My Pi hook translated eleven of
  its own. Anything else fell through and recorded nothing on success.

  `src/hooks/tool-vocabulary.ts` is now the seam. A harness owns a table; the module owns what a
  table means — an id is mapped to a canonical name (optionally rewriting the payload into the
  fields the extractor reads), declared silent with the reason written down, or left absent. A
  declined mapping still passes the call through under the harness's own name, so a failed tool
  records its error regardless of whether its payload fit a shape.

  `src/hooks/extractors.ts` exports the canonical set the harnesses may target and gains four
  shapes they needed: GitHub write operations (`github_pr_create`, `github_pr_push`,
  `github_pr_checkout`, `github_run_watch`), a started security scan (`security_scan`), an
  agent-written context note (`context_note`), and context lifecycle changes
  (`context_checkpoint`, `context_rewind`, `context_reset`). Promotion tags the two new categories
  through the documented `category:<category>` fallback, as `task`, `subagent`, `skill` and `mcp`
  already do.

  Codex gains `update_plan` (a `task_update` naming the step in progress) and `spawn_agent` (a
  `subagent_dispatch` when the payload names one); a `write_stdin` poll is declared transport. Oh
  My Pi gains `todo`, `github`, `security_scan`, `context_notes`, `checkpoint`, `rewind` and
  `new_context`, and declares its own memory tools silent so lcm neither duplicates nor feeds back
  what the harness already remembers.

- 1b16d5e: chore: the storage root is constructed at each composition root instead of imported

  `defaultLcmPaths` and `lcmPath()` are gone. The CLI's `main()`, `createDaemon()`, and the
  hooks builder each build one `LcmPaths` and thread it down through batch compaction,
  bootstrap, import, replay state, sensitive-pattern
  commands, stats, portable knowledge, and language packs. The package entry point now
  exports `createMemoryApi(client)` without constructing an ambient default client.
  `daemon/config.ts`'s `socketPath` default is derived from `configPath`'s own directory
  instead of resolving the root again.

  The paths guard test grows two checks rather than a duplicate: `homedir()` outside the
  factory must be a host-harness or user-typed path, and every remaining `lcmHome()` call
  site is named as either a composition root or a library fallback still to be threaded.

  Library helpers do not resolve the storage root from the ambient environment. Callers
  that choose the root pass the resulting `LcmPaths` through every storage access.

- c6d3b6c: feat: agents can vote on a promoted memory; `lcm stats` surfaces promotion candidates and contested memories

  `lcm_store` accepts a `signal:memory_vote` record: `vote:+1` ("checked against current evidence and still correct") or `vote:-1` ("checked and contradicted"), naming the target with `memory_id:<id>`, with a reason required in the text on both directions. A malformed vote — missing or duplicated `memory_id:`/`vote:` tags, an unrecognized vote value, or an empty reason — is rejected with a message naming the broken rule. The target may live in a sibling checkout of the same repository; the store resolves it the way `lcm_describe` resolves a `projectId` and writes the vote into whichever database holds it. A repeated identical vote from the same real session counts once; a later opposite vote from the same session archives the earlier one.

  `lcm stats` and `lcm_stats` gain two sections, always shown when non-empty: **Promotion candidates** (memories with reported uses at or above the new `promotion.enforcementThreshold`, default 3, shown with their `+1`/`-1` counts) and **Contested** (any memory with at least one `-1`, with each objection's reason and vote id). A contested entry clears by archiving the memory, superseding it with a corrected `lcm_store`, or dismissing a single objection by archiving its own vote id through the existing `/review-stale` archive action. Recall is unchanged: votes affect no ranking, scoring, or prompt-time injection.

  Fixes a gap this made visible: `signal:memory_used` and `signal:memory_vote` records were previously reachable through `lcm_search` and the prompt hook like any other promoted memory. Both are now excluded from every promoted-memory search — they exist to be counted, not surfaced.

- 6b21809: Add Oh My Pi as a first-class session client with connector installation, native lifecycle hooks, transcript import, and replay alongside Claude Code and Codex.
- bfb7fa5: feat: passive-learning events record client and model provenance; Codex captures PostToolUse

  Every event in the passive-learning sidecar now carries `client` (`claude` or `codex`, the harness that produced it — existing rows read back as `claude`) and `model` (the model that issued the tool call). Codex's `PostToolUse` / `PostToolUseFailure` hook payload carries its model when the host sends one; Claude Code's never does, so that column stays null until the session's transcript is next ingested, which backfills it by matching each tool call's id.

  `lcm codex-hook` now handles `PostToolUse` and `PostToolUseFailure`: the payload's field names already match the shape `src/hooks/extractors.ts` consumes for Claude Code, so one extractor, one allowlist and one truncation rule cover both harnesses, and it writes straight to the project's local sidecar with no daemon round trip. `lcm connectors install codex` registers the two new hooks; reinstalling stays idempotent.

  What this does not yet cover, for a native Codex host: a `tool_name` Codex serializes under its own name rather than Claude Code's (`apply_patch`, `exec_command`) matches no extractor branch, so it produces no event; and a payload that omits `model` leaves the column null, because the per-turn transcript backfill exists for Claude Code only.

- 9e10fda: feat: `lcm_search` takes a `pivotQuery`, the caller's own translation of the query

  A project's author may write in one language while most of the text that answers
  a query — tool output, code, summaries — is in another. `lcm_search` now accepts
  an optional `pivotQuery`: the caller's translation of `query` into
  `search.pivotLanguage` (new, default `en`). Each side is prepared on its own, so
  each loses only its own language's function words, and the two term sets are
  searched together — a hit through either side counts. Without a `pivotQuery`, or
  with one that adds no term, search behaves exactly as before.

  The caller is told when to supply one: the `lcm_search` description names the
  project's author language and the pivot language when they differ, a search
  response carries both once a language has been recorded for the project, and the
  `<memory-context>` block the prompt hook emits carries the same one-line hint.
  No model call is added inside the daemon at query time, and `lcm_grep` keeps its
  literal semantics.

- 9a44005: feat: generate new summaries in the project's recorded language

  Add `summarizer.language` for an explicit output language. When it is unset,
  new summaries use the project's recorded author language when available;
  existing captured messages and summaries are unchanged. Configured values are
  canonicalized as BCP 47 language tags and invalid tags are rejected.

- 950a2b9: feat: the Claude Code plugin is self-contained; Codex stays on the npm CLI

  The plugin runs from a prebuilt `bundle/` committed at each release: hooks and the MCP server call `bundle/lcm.js` and `bundle/mcp-server.js` in exec form (`command` + `args`, no shell), so a marketplace install works with only `node` on PATH. No hook installs packages, compiles, or touches PATH any more. `lcm.mjs`, `mcp.mjs` and `.claude-plugin/lcm-mcp.sh` are removed, and `config.json` no longer carries `mcpNodePath`.

  One daemon serves both distributions, newest wins: a newer caller restarts an older daemon; an older caller connects when the compatible component matches (the minor while 0.x, the major from 1.0) and warns once; an incompatible one fails open. A hook that cannot run exits 0 and writes one stderr line per session naming the repair command; `lcm doctor` reports the same conditions and checks the installed bundle.

  `lcm install` now also provisions Codex globally when `codex` is on PATH, reports one outcome per harness, exits non-zero on any failure, and `--dry-run` writes nothing at all.

  Releases: the version PR builds and commits `bundle/`; `publish.yml` only tags, publishes and creates the release as before.

- 41bb250: feat: SessionStart catches up conversations left uncompacted by a session that ended without `SessionEnd`

  A session killed by a crashed terminal, a sleeping machine, or a daemon that
  was down at exit kept its raw messages captured but never summarized — only a
  manual `lcm compact --all` revisited it. Every SessionStart now fires one
  non-blocking `POST /session-start-compact` request; the daemon selects
  conversations of the same project with enough raw messages not covered by summaries
  or protected as the fresh tail, excludes the session that is starting,
  conversations already compacting, and conversations below
  `compaction.autoCompactMinTokens`, and requests
  compaction for at most `compaction.autoCompactSessionStartMax` of them
  (default 2), oldest first, so a larger backlog drains over several starts.
  `hooks.disableAutoCompact` turns the sweep off. Session-start latency is
  unaffected: the request is fire-and-forget, mirroring the one `SessionEnd`
  already uses.

### Patch Changes

- 59834e7: fix: `bench run` cleans up its temporary ripgrep directory and reports the original error

  A failure while acquiring the database connection left the `lcm-bench-rg-*`
  directory behind. Connection acquisition and scoring moved inside the `try`
  whose `finally` removes that directory, so it is cleaned up on every path.
  Those failures now return `exitCode: 1` with the error text on stdout instead
  of propagating, and a rejection from the cleanup itself no longer replaces
  that error.

- af0e7c5: chore: the bench temp-directory cleanup test no longer reads another run's directory

  `lcm bench` copied conversation text into `mkdtemp(join(tmpdir(), "lcm-bench-rg-"))`, a name no
  process owns. The regression test that asserts the directory is removed on every path — including a
  failure to acquire the database connection — identified its own directory by diffing `lcm-bench-rg-*`
  entries in the shared temp root, so under two concurrent suite runs the first new entry could be
  another run's live directory and the assertion read as a leak (issue #537).

  The directory is now created under `lcm-bench-rg-<pid>-`, and the test matches that process-scoped
  prefix. The assertion itself is unchanged: the created directory is still captured rather than
  counted, so a run that never created one fails.

  Test infrastructure only: nothing about the emitted CLI or the daemon changes.

- c945159: Client separation pass: session-client identity, capability-bearing transcript adapters, one owner for Claude Code's project-directory name.

  `src/session-client.ts` now names the one session-client type (`"claude" | "codex"`), kept deliberately separate from summarizer providers; the hook, events and ingest code import it instead of restating ad-hoc unions.

  The transcript-source seam no longer leaks Codex into shared types: the resume cursor became an adapter-opaque `checkpoint`, loaded and persisted through the adapter inside capture's write transaction, and the ingest route reads client capabilities off the adapter (`mayRecoverTail`, `discoverSubagents`) instead of comparing the client string; `POST /prompt-search` takes an explicit `nativeHistory` flag from the Codex hook rather than forking on the client name. Shared hook helpers moved to `src/hooks/tool-events.ts` (tool-event recording) and `src/hooks/daemon-requests.ts` (fire-and-forget daemon requests), so neither client's adapter imports the other's entry-point module.

  Claude Code's project-directory slug (`~/.claude/projects/<slug>`) has one owner, `claudeProjectSlug` in `src/daemon/project.ts`: the cwd with every non-alphanumeric character replaced by `-`. `lcm import`, `lcm diagnose` and the daemon's periodic transcript scan previously re-implemented older slash-only variants, so projects whose path contains a dot or underscore silently found no sessions; the periodic scan additionally dropped the leading dash and matched nothing at all. The scan pass is now a named export, exercised directly by tests that pin the slug rule and refuse the old slash-only name.

- d8837e5: Capture native Codex `apply_patch` and compatibility `exec_command` passive-learning events, and backfill a missing event model from the matching transcript turn.
- 88e7c14: Show command help before validating required positional arguments, so every `lcm` subcommand accepts `--help` without running its action.
- cd8b8fa: chore: `CompactionEngine` exposes only `compact`

  `evaluate`, `compactLeaf` and `compactUntilUnder` had no caller and are
  removed, together with the `maxRounds` config key and the `CompactionDecision`
  type that only they used. `compactFullSweep` is folded into `compact` and
  `evaluateLeafTrigger` is private to it.
  `docs/architecture.md` describes the one sweep the daemon runs.

- 3859d63: fix: the skill connector installs where Codex and Copilot read it

  The `skill` connector for Codex and GitHub Copilot now installs to `.agents/skills/lcm-memory/SKILL.md`, the location both hosts actually read (Codex only scans `.agents/skills`; Copilot also accepts it). One installed file now serves both hosts in a repository that uses both. Installing or removing the skill connector also clears a pre-existing copy at the old location (`.codex/skills/` or `.github/skills/`) so the two copies never coexist.

- 3021d91: Harden cross-checkout memory feedback: validate explicit owners, reject ambiguous target IDs,
  register ordinary stores for sibling discovery, expose actionable memory IDs in MCP stats, and
  count unambiguous legacy requester-side use signals once during upgrade.
- 55b38f6: Keep cross-checkout memory use and vote feedback with the memory owner, and let stale review resolve explicitly owned entries across a project group.
- a17fbea: chore: a build records the sources it was made from, and the suite refuses a stale one

  `npm run build` now also writes `dist/BUILD_SOURCES`, a fingerprint of the files the build
  reads (`src/`, `bin/`, `installer/`, `tsconfig.json`). The test suite recomputes it before
  every test file and fails with the rebuild command when `dist/` no longer matches the working
  tree.

  Suites that spawn the built CLI — golden snapshots, help routing, daemon hold behaviour, the
  e2e flows — compared a `dist/` built from older sources against committed expectations, so an
  edit without a rebuild passed locally and failed in CI. Test infrastructure only: nothing
  about the emitted CLI changes, apart from the new fingerprint file travelling with it.

- ad696c9: fix: one owner for Claude Code's project-directory name, and documentation corrections

  Three modules encoded Claude Code's `~/.claude/projects/<cwd>` naming rule and two disagreed with
  the third and with Claude Code: `cwdToProjectHash` in `src/import.ts` replaced only slashes, and
  the daemon's periodic transcript sweep additionally stripped the leading dash. A cwd holding a
  `.`, `_` or `+` was therefore never matched, so `lcm import --all` skipped those projects, `lcm
diagnose` looked in a directory that does not exist, and the ten-minute catch-up sweep found
  nothing for any project. The rule now lives once, as `claudeProjectSlug` in
  `src/daemon/project.ts`, and every reader of `~/.claude/projects/` goes through it.

  `lcm compact --help` lists `-v, --verbose`, and `lcm stats --help` lists `--pool` and `--json`;
  all three were installed and undiscoverable. The "Anthropic provider needs a key" error names the
  variable the daemon actually reads — `llm.apiKey` in `config.json`, or `ANTHROPIC_API_KEY` — where
  it previously named `LCM_SUMMARY_API_KEY`, which no code path ever read and the docs taught.

  Corrections in tracked documentation: `docs/privacy.md` states the real default summarizer
  (`auto`, so the running harness's CLI does send the text it summarizes) and what `lcm uninstall`
  actually removes; `docs/hook-protocol.md` describes auto-heal's direction, the `<memory-context>`
  block, the `tool_output` shape, the post-tool daemon call and the `Stop` event;
  `docs/architecture.md` drops the assembler, the `<summary>` XML format and the non-existent
  lifecycle hooks and reconciliation in favour of what `createRestore` and the transcript sources
  do; `docs/import.md` states that Codex tool calls and outputs are imported as `tool` messages;
  `RELEASING.md` states that merging the version PR publishes and that the tag precedes npm;
  `docs/configuration.md`, `docs/agent-tools.md`, `docs/search.md`, `docs/fts5.md`,
  `docs/passive-learning.md`, `docs/ci-runner.md`, `README.md` and `AGENTS.md` carry the rest.

- 02fef82: feat: English is a language pack like every other language

  `lcm search` and `lcm grep` no longer drop a hardcoded English stopword list
  from every query. English's function words now ship as a built-in language
  pack, applied only when English is one of the languages the search is
  configured for (the project's recorded author language, or
  `search.pivotLanguage`) — the same rule every other language's pack already
  followed. A project with no recorded language now loses no function words at
  all, for any language, instead of English's alone. Pivot-pack generation on
  ingest no longer special-cases English: it is ensured the same way as any
  other pivot language, and the built-in pack means that ensure step is a no-op
  for English rather than a model call.

  A machine that already has a model-generated `~/.lossless-claude/languages/en.json`
  now has that file replace the built-in list rather than add to it, the same as
  a hand-edited file replaces a generated one for any other language tag.

- 660a33e: fix: `lcm install --dry-run` previews the skill copy instead of failing

  The dry run exited 1 because the `/memory` skill copy ran for real while its
  target directory was only pretended. The skill copy, the removal of the
  per-command files earlier versions installed, and the plugin cache cleanup now
  all go through the dry-run layer, so a dry run writes and removes nothing. The
  skill source is also found when lcm runs from source, not only from `dist/`.

- 70834df: chore: the tests that failed only under CPU load no longer report a regression

  Three tests failed only when the suite ran on a busy machine (issue #526):

  - The recall gate combined four assertions — recall@5, beating the grep baseline, the empty-result
    rate and query latency — in one test body with a 15 s vitest timeout. Under load that body
    outlived the timeout, so the run reported a wall-clock failure that reads as a search regression
    while every quality number was green. The measurement is now a single shared pass; the quality
    thresholds and the latency budget are separate tests, and the latency budget is scaled by a
    contention probe taken in the same pass. The documented 500 ms is the floor of that budget: an
    idle machine at the reference speed pays exactly it, and a busy or slower one fails with a
    message naming the measured time and the budget it missed. The pass itself keeps a 120 s
    wall-clock budget, so contention can no longer kill it as a timeout.
  - `test/installer/dry-run-deps.test.ts` wrote a fixed `lc-test-setup.sh` name into the shared temp
    directory; a second suite run deleting that file between the write and the spawn made bash exit
    127, which reads as a broken installer. The name is unique per process now.
  - `test/hooks/restore.test.ts` and `test/hooks/session-snapshot.test.ts` used fixed session ids,
    and the restore lock and the function-hooks claim are fixed paths under the shared temp directory
    keyed by that id: a concurrent run could hold, claim or delete them, and the hook went silent — or
    answered — for a reason the test never set up. Ids are unique per process now.

  Test infrastructure only: nothing about the emitted CLI or the daemon changes, and no threshold is
  lowered.

- e6d17df: fix: the `<memory-context>` block names a sibling checkout's memories with their project

  Promoted memory is unioned across every checkout of a repository, so the `<memory-context>` block
  a prompt receives could surface a memory from a sibling checkout. Its id, listed bare in the
  trailing `surfaced-memory-ids` comment, then resolved against the current project and answered
  "not found" when passed to `lcm_describe` or `lcm_expand`. An id from a sibling now renders as
  `<id>@<projectId>`, and the block's intro sentence tells the agent to pass that suffix as
  `projectId`. An id from the current project keeps its bare form.

- 586e792: Stopword packs follow the configured languages: the project's recorded author language for `query`, `search.pivotLanguage` for `pivotQuery`, matched on the primary subtag. The words in a query no longer choose a pack, so a mixed-language string cannot activate one neither side would, and a non-English pivot language gets its pack generated at detection. `lcm bench` scores an optional `pivotQuery` per question the way `lcm_search` does; the measurement of the shipped `pivotQuery` is recorded in `docs/search.md`.
- f04a35f: A project's `meta.json` has one owner, `src/daemon/project-meta.ts`, with one corrupt-file policy: an update moves an unparsable file aside as `meta.json.corrupt-<timestamp>` and starts again from the caller's keys, and a read treats it as absent. Ingest, compact, promote, git identity and language detection each update their own key and keep every other, so a record no longer loses `git`, `language` or its timestamps depending on which path touched it first. Writes land through a temporary file and a rename, so a crash mid-write cannot leave a torn record.
- 88f5607: fix: stale daemon-activity markers no longer accumulate without bound

  Every hook and CLI entry that touches the daemon writes a startup marker and
  removes it when its work settles; a process that dies first (a killed hook,
  a crashed CLI) left the marker behind forever, so the directory could grow to
  hundreds of files. Markers now live in `tmpDir` instead of the storage root,
  and a marker whose pid is no longer alive — or that has aged past one hour,
  so pid reuse cannot resurrect it — is pruned whenever markers are scanned or
  a new one is registered. A marker is kept while the process that wrote it is still the process holding that pid —
  decided by the owner's own elapsed running time, so a recycled pid cannot make a marker
  immortal and a long operation cannot age out under its own owner. Where the owner's
  lifetime cannot be read, the one-hour cutoff is the fallback, and a registration refreshes
  its marker while its work runs. The directory versions before this change wrote to is still
  swept, so an upgrade leaves nothing behind there.

- e1c8ebe: Removed `LCM_INCREMENTAL_MAX_DEPTH`, a documented environment variable that had no consumer: no code path ever read it into a decision, so setting it changed nothing.
- ad7f23f: refactor: the restore assembly moves behind one entry point in `src/daemon/restore/`

  `createRestore(config, paths)` is the module's only entry point, and it answers one call
  with one of three outcomes — the context, an unusable `cwd`, or a fault — so `POST /restore`
  no longer throws its way to a status. Everything the route used to hold now sits behind
  that seam: which client is asking, whether the restore follows a compaction, the Claude
  CLAUDE.md snapshot replay-versus-refresh rule, the Codex byte budget, the passive-capture
  insights that ride beside the context, and the fencing. `src/daemon/routes/restore.ts` is
  the wire only.

  The module opens one project-database connection per call where the route opened up to
  four, and the two route suites are now suites of the module: they call `createRestore`
  directly against temp project databases instead of driving a daemon over HTTP. The
  snapshot's reader moved to `src/daemon/restore/instructions.ts`, so the `homedir()`
  allowlist follows it; the route keeps a wire test covering the status and body mapping.

- 8aefaec: Ranked full-text search over messages and summaries orders by `rank` alone in SQL, so FTS5 applies the candidate limit itself and the source row and snippet are read only for the candidates kept; before, every matched row was joined and snippeted before the limit, and a many-term query on a large corpus took seconds. Newer matches still break relevance ties, now among the kept candidates, so which equal-rank rows sit at the limit boundary may differ.
- 63dbd0b: The SessionEnd hook hands the whole end-of-session sequence to the daemon in one acknowledged request (`POST /session-end`): ingest, then compact, promote, promote-events and session-complete run daemon-side after a `202`. The host's SessionEnd budget no longer cancels the hook mid-ingest and drops the steps after it. The redaction notice moves from the terminal to the hook error log.
- 871f86d: fix: `/compact` captures transcript messages through the same module as `/ingest`

  A session whose first messages reached the database through `/compact` had no
  `message_parts` rows and, for a subagent transcript, no attribution on its
  conversation. One capture module (`src/capture.ts`) now owns writing a
  session's new messages for every route, including reading a subagent
  transcript's sidecar when the caller supplies no attribution.

- f00c265: Live `/ingest` now captures subagent transcripts nested under a workflow run
  (`subagents/workflows/wf_<id>/`), as `lcm import` already did: one directory walker
  serves import, live ingest and the migration backfill, which now also attributes
  transcripts nested under a workflow run. A sidecar that is not a JSON object, or a
  nested directory that cannot be read, no longer drops or aborts discovery.
- 9a2c51d: `lcm stats` and `lcm_stats` show the share of conversations search excludes as subagent transcripts

  Search drops subagent transcripts by a session-id naming convention (`agent-`) owned by the
  host harness. The Memory section now reports how many stored conversations that rule matches,
  over all conversations, and how many the `.meta.json` sidecar attributed to a parent session
  without matching the rule — the count that turns non-zero when the convention drifts.

- 0afefcf: chore: the stores are the only readers and writers of Episodic and Promoted memory's tables

  `ConversationStore` and `SummaryStore` expose the operations Episodic memory
  is asked for — find a session's conversation, append a delta, read the context
  window, replace a range with a summary — and the daemon routes, the importer
  and the capture module go through them instead of preparing their own
  statements; a test pins that. Methods only tests called are removed.
  `PromotedStore` is the one reader of `signal:memory_vote` rows, so how a vote
  is encoded in its tags is decided in one place. `/recent` answers summary
  records in the store's shape (`summaryId`, `tokenCount`, `createdAt`, …).

- 927b53b: fix: subagent transcripts dedupe by session id and ingest independently, and attribution backfills on an existing row

  Two subagent transcripts sharing a basename at different depths under
  `subagents/` now dedupe to the first one found instead of one call slicing
  the second transcript by the first one's stored message count. One subagent
  transcript that fails to parse or capture no longer aborts `/ingest` for its
  siblings — the failure is logged and the loop continues. A subagent captured
  before its `.meta.json` sidecar existed now gets its parent, type and
  description filled in on the next `/ingest` that finds the sidecar, instead
  of staying unattributed forever.

- 0a1647b: refactor: one transcript-source interface behind `/ingest` and `/compact`, with a Claude and a Codex adapter

  Reading a transcript now goes through one interface with an adapter per
  harness, called only by the capture module; neither `/ingest` nor `/compact`
  branches on the client to decide how a transcript is read. `/compact` with a
  Codex `transcript_path` now ingests that session's delta through the Codex
  cursor, where it previously validated the path against Claude Code's
  transcript directory and read nothing, and answers 400 for a Codex transcript
  the adapter refuses instead of silently skipping it.

- abcb12b: Update the bundled secret-detection patterns from gitleaks.

## 0.12.0

### Minor Changes

- 40c5769: feat: one `/memory` skill replaces the nine slash commands

  `/memory <command> [options]` runs any CLI command after reading `lcm help <command>`, and
  shows the output verbatim. It replaces `/lcm-compact`, `/lcm-curate`, `/lcm-diagnose`,
  `/lcm-doctor`, `/lcm-import`, `/lcm-promote`, `/lcm-sensitive`, `/lcm-stats` and
  `/lcm-status`, each of which only ran the command of the same name. `lcm install` installs
  the skill to `~/.claude/skills/memory/` and removes the command files earlier versions left in
  `~/.claude/commands/`.

  Removed with them, for lack of use: the `lcm-context` skill (the MCP tool descriptions say
  when to use each tool) and the four agents `compaction-reviewer`, `health-investigator`,
  `memory-explorer` and `transcript-debugger`.

### Patch Changes

- 056ed1c: fix: live `/ingest` discovers subagent transcripts, not only `lcm import`

  Previously, a subagent transcript reached the database only when someone ran
  `lcm import` by hand — `/ingest` parsed only the session's own transcript.
  `/ingest` now also discovers that session's `subagents/*.jsonl` transcripts
  and ingests each one with the same attribution `lcm import` already writes,
  so a session that dispatched agents has their conversations recorded without
  any command being run. Re-ingesting the same session does not duplicate
  subagent messages, and a session with no subagents is unaffected.

- 924bada: fix: check-manifest verifies dist/ imports match declared dependencies and versions stay in step

  The published MCP server could import a package the manifest never declared, which failed silently past the bootstrap's `npm install` and only surfaced as `CONNECTION_CLOSED` in a user's session. `npm run check-manifest` now runs in CI and before publish: it fails the build if `dist/` imports anything outside `dependencies` ∪ `peerDependencies` ∪ `optionalDependencies`, or if `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json` disagree on version. `version-packages` now also runs `scripts/sync-versions.mjs` to keep the two plugin manifests in step with `package.json` automatically. `mcp.mjs`'s bootstrap no longer swallows a failed `npm install` or `npm run build` silently — the error now reaches stderr, next to the `CONNECTION_CLOSED` symptom in the debug log.

- 9b2513d: fix: the MCP server no longer depends on PATH to resolve node

  The plugin's MCP entry ran bare `node`, and the untracked entry lcm writes into an
  agent's own config (`~/.claude/settings.json`, `.mcp.json`, …) ran bare `lcm` —
  which itself depends on PATH resolving `node` via its shebang. Either could fail with
  `CONNECTION_CLOSED` and no clue why on a session whose PATH doesn't match the shell
  `lcm` was installed from (nvm, volta, a Homebrew shim, a sandboxed plugin runtime).

  `plugin.json` now points at `.claude-plugin/lcm-mcp.sh`, a static, tracked launcher
  that reads the node interpreter lcm's own hooks already recorded in
  `~/.lossless-claude/config.json` (`mcpNodePath`, written by `ensureCore` from
  `process.execPath`), falling back to `command -v node` when nothing is recorded yet.
  The entry lcm writes into an agent's own config now carries `process.execPath` and
  the absolute path to the installed `dist/bin/lcm.js`, both measured at install time —
  naming neither `lcm` nor `node` by name. See
  `docs/design/mcp-interpreter-resolution.md`.

- e54b2a5: fix: one storing rule across every guidance surface

  `~/.claude/lcm.md` banned manual storing while the connector skill made `lcm store` mandatory on every code task. Every generated surface now states the same rule: store durable insights (decision, preference, root-cause, pattern, gotcha, solution, workflow) explicitly, tagged with `type:`, one concise insight and its why per store.

- 943be9f: fix(plugin): a fresh plugin install fetches the released tag, not `main`

  The marketplace entry now carries `ref: vX.Y.Z` beside `version`, written by the
  same version sync that stamps `plugin.json`. Before, a new install cloned the
  default branch's HEAD under the released version's label, so two users on
  "0.11.0" could run different code. The publish workflow tags before it publishes
  to npm, so the ref is valid as soon as the version commit lands.

- 1dffcc3: fix(plugin): the `lcm-context` skill now loads; two stale files leave the plugin

  The skill lived under `.claude-plugin/skills/`, which Claude Code does not scan, so
  no plugin user ever saw `/lcm:lcm-context`. It now lives at `skills/lcm-context/`,
  the location the plugin loader reads by default, and its recovery table names the
  real command (`lcm daemon start --detach`).

  Removed from the plugin: the `lossless-claude-upgrade` skill (a rebuild-from-source
  recipe for developing lcm, which also never loaded) and `.claude-plugin/hooks/README.md`
  (it listed four hooks where the plugin registers seven; `docs/hook-protocol.md` is
  the reference).

- 081b69a: feat: record skill invocations and slash commands as `message_parts` structure

  A skill's name arrives in the `Skill` tool_use's own `input.skill` field, and a slash
  command arrives as a `<command-name>` block — both already reach the database, but only
  as a substring of a message body, so nothing could filter on them. `parseTranscript` now
  extracts both into `message_parts` rows (`skill` / `command`), used by both CLI import and
  the daemon's `/ingest`. Existing databases get their `part_type` `CHECK` rebuilt to admit
  the two new values, then backfilled once, both straight from stored message content, no
  disk read: slash commands from the `<command-name>` block, and skill names from Claude
  Code's own "Launching skill: `<name>`" follow-up line, which is stored verbatim.

- f470be1: fix: subagent transcripts keep their parent session, type, and description

  Subagent conversations imported from `~/.claude/projects/<session>/subagents/` now carry
  `parent_session_id`, `subagent_type`, and `subagent_desc`, read from each transcript's
  `.meta.json` sidecar. A one-time migration backfills these for subagent conversations
  already ingested, matching against transcripts still present on disk.

- 4fa121a: fix: the tag vocabulary is generic

  The learning instruction and the `lcm_store` tool description name five tag prefixes:
  `type:`, `scope:`, `project:`, `source:`, `priority:`. The `owner:` and `sprint:` prefixes,
  which described one organisation's process, are gone from the guidance; tags already stored
  with them are untouched. `lcm_store` describes its target as the promoted layer, the name
  `lcm_search` uses for the same layer.

- 23369bb: fix: the documented `LCM_*` tuning variables and `LCM_ENABLED` now take effect

  `LCM_CONTEXT_THRESHOLD`, `LCM_FRESH_TAIL_COUNT`, `LCM_LEAF_MIN_FANOUT`,
  `LCM_CONDENSED_MIN_FANOUT`, `LCM_CONDENSED_MIN_FANOUT_HARD`,
  `LCM_INCREMENTAL_MAX_DEPTH`, `LCM_LEAF_CHUNK_TOKENS` and
  `LCM_CONDENSED_TARGET_TOKENS` reach the compaction engine, and `LCM_ENABLED=false`
  makes every hook a no-op. They were read by a resolver nothing called. The defaults
  are the engine's existing values, so an environment that sets nothing behaves as
  before; the README table now states those values.

  Removed from the documentation, because nothing reads them: `LCM_LEAF_TARGET_TOKENS`,
  `LCM_MAX_EXPAND_TOKENS`, `LCM_LARGE_FILE_TOKEN_THRESHOLD`, `LCM_AUTOCOMPACT_DISABLED`,
  `LCM_SUMMARY_MODEL`.

  The npm package ships the user-facing documents only, not the repository's
  development notes.

- 0734f70: fix: the four bundled agents now load with their frontmatter, and CI validates the plugin

  `agents/memory-explorer.md`, `agents/compaction-reviewer.md`,
  `agents/transcript-debugger.md` and `agents/health-investigator.md` each wrote a
  multi-line `description` as a plain YAML scalar, which does not parse. Every one
  of them had been loading with its name taken from the filename and every other
  field — description, model, color, tools — silently dropped, since the first
  release that shipped them. The descriptions are now literal block scalars, byte
  for byte the same text, and they parse.

  `ci.yml` runs `claude plugin validate` after `check-manifest`: strictly against
  `.claude-plugin/marketplace.json`, and, naming `.claude-plugin/plugin.json`, a
  full walk of the plugin's agents, skills, commands and hooks module. That walk is
  what found the frontmatter defect above. `.claude-plugin/marketplace.json` also
  gains the top-level `description` that `--strict` asks for.

  This does not replace `npm run typecheck:hooks`, which stays local-only:
  `plugin validate` checks structure, not whether a `$` method still exists on the
  running build. Both reasons are now written down, in `docs/ci-runner.md` and
  `docs/hook-protocol.md`.

- 9b60300: fix: workflow subagent transcripts are now discovered and imported

  Subagent transcripts dispatched inside a workflow run live one directory deeper,
  under `subagents/workflows/<run>/`, and discovery only ever looked at files
  directly inside `subagents/`, so an entire class of subagent conversations was
  silently skipped. Discovery now walks into subdirectories of `subagents/` to
  find them, reading the same `.meta.json` sidecar attribution as a flat subagent
  transcript. Each workflow run also writes its own `journal.jsonl`, which is not
  a transcript and stays excluded by name.

## 0.11.0

### Minor Changes

- 48346a8: Add native Codex lifecycle hooks for automatic restoration, prompt recall, incremental capture, and continuity across compaction. Preserve unrelated hooks and report configuration separately from host trust and activation.

  Include active and archived Codex sessions in the default import replay selection, reuse incremental ingestion across hooks and imports, and keep internal Codex summarization out of captured history.

- a15ffd7: Stop `lcm search` from returning subagent transcripts. Claude Code writes a dispatched agent's transcript as `agent-<id>.jsonl` and ingestion keeps it as a session, so ranked recall was competing the user's own history against review panels arguing about diffs — 78% of ingested sessions here, above 90% on some projects. Measured over 202 questions whose answers are human sessions, skipping them gains 14 and loses none (hit@5 0.337 to 0.406, sign test p = 0.0001). The transcripts stay ingested and stay reachable through `lcm grep` and `lcm expand`; only ranked search stops offering them unprompted. `lcm bench build` samples from the same population, so its questions are answerable by the search it grades.
- c162f56: First function-hooks module (Claude Code early access, behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), in `hooks/lcm-hooks.ts`. One `tool.call` hook replaces the PostToolUse and PostToolUseFailure command hooks: it runs after the tool, reads success or failure from the result, and posts the call to the daemon's new `POST /tool-event` route, which writes the same passive-learning rows the command hook wrote. A `prompt.submit` hook replaces UserPromptSubmit: `/prompt-search` now accepts `recordEvents` and `format: "context"`, and the rendered memory context rides as hidden context on the prompt. The learning instruction moves from every prompt into the system prompt's `memory` section once per session via `prompt.section`, so it stops costing about 1 KB per message. A `turn.complete` hook replaces the Stop hook's snapshot: `/ingest` now derives the transcript path from `session_id` and `cwd` when none is given. When the daemon has idled out, the module restarts it with `lcm daemon start --detach` and retries once, as the command hooks did through `ensureDaemon`. No `node` process is spawned per tool call, per prompt or per turn while the module is loaded. While the flag is set, `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` stay silent so nothing lands twice; the test suite clears the flag so a developer's own session cannot change its results. A daemon without the new routes is reported once per session, not per call.
- 386ac67: Migrate the stdio MCP server to protocol revision 2026-07-28 with TypeScript SDK v2. The
  earlier 2025-11-25 revision is still served, so which one a connection uses is the
  client's choice; only the newer one carries the result envelope. The seven tools and both
  entrypoints remain available, and the doctor MCP probe uses the new protocol.
- cf37e51: Rank sessions by relevance rather than by size. `lcm search` scored a session by the reciprocal rank of the best position any single one of its rows reached, so a long session — entering the candidate pool many times — landed a row high on almost any query and crowded out shorter, more relevant ones: measured, one 368 KB session took 11 of 13 top-5 slots on unrelated questions. Session scores are now damped by the session's message count, the way bm25 already damps a message by its length. Chosen on five corpora and graded once on four it had never seen, hit@5 moves 0.269 to 0.320 (+13 questions against −3, sign test p = 0.02), improving on every held-out corpus.
- 9246ee0: New summarizer provider `llm.provider: "session"` (Claude Code function hooks, early access). Instead of calling an API, the daemon hands each summarization job to the function-hooks module of the live session that owns the transcript, which answers through the session's own client: `$.model.complete` with `haiku` for leaf chunks, `$.model.fork` for condensed nodes, `complete` again when the fork has no warm cache. The module serves only its own session's jobs, through a long-poll on `GET /summarize-jobs/next` and `POST /summarize-jobs/:id`, and spends at most `sessionSummarizerMaxOutputTokens` output tokens per session (plugin `userConfig`, default 50000, 0 disables). A job unanswered within 20 s, or answered with an error, goes to `llm.fallbackProvider` when set and to today's `auto` resolution otherwise; a provider the user named explicitly is never bypassed. Usage lands in `llm_usage_stats` as `session:haiku` or `session:fork`, with `calls_estimated` counting the `complete` calls whose tokens are estimated. The engine keeps all DAG bookkeeping; triggers (PreCompact, SessionEnd) do not change.

### Patch Changes

- ea10a75: Write `lcm bench build --generator llm` questions in the language the corpus's author asks in. The generator paraphrased whatever prompt it was handed, so questions inherited the prompt's language: 58 of 60 generated questions came out English against 11 of 13 hand-written ones in pt-BR, because the sampled prompts are mostly pasted code and tool output. Such a set measures same-language paraphrase recall, a task the person never performs. The language is now read once per build from a sample of the corpus's human turns, recorded on the file as `language`, printed by `run`, and overridable with `--language` (`LCM_BENCH_LANGUAGE` in the corpora harness); a build that cannot tell fails instead of defaulting to English. The corpora harness builds with the LLM generator, since mechanical templates are English by construction.
- 2280011: Four correctness fixes in `lcm bench`, all confirmed by the review panel on #361. Repeated-prompt detection now compares prompts trimmed, so the same text with a trailing newline in another session no longer slips through as unique evidence, and the grouping is bounded to prompt-sized rows instead of loading every repeated paste in the corpus. Session labels are matched trimmed, so a hand-curated `sessionId` with a stray space scores its hit instead of silently missing. A benchmark file that exists but does not parse now reports the parse error rather than "No benchmark file", whose advice — run `bench build` — would have overwritten the file being fixed.
- 147214e: Cut both `lcm bench` columns at the same point. The score is over sessions but search ranks rows, so asking for `k` rows and then deduplicating by session surfaced 3.3 sessions per query on a real 105-session corpus instead of `k` — several rows of one session ate the budget — while the ripgrep baseline walks its hits until it has `k` distinct sessions and always fills them. The comparison handed grep more chances than search on the same question. Search now gets a row budget that fills every slot; the reported hit rates are unchanged on both local benchmarks, so this removes a confound rather than moving a number.
- 59f5bf3: Report what `lcm bench` actually measures. The `--json` report exposed a single-source hit rate under the name `searchRecall`, and `bench build` sampled any user prompt — including harness boilerplate and text repeated across sessions, neither of which a single source label can score: search can return a genuinely correct session and be counted as a miss. `build` now only samples prompts whose text occurs in exactly one session, questions take an optional `sessionIds` list whose every entry scores as a hit, and the report fields are `searchHitRate` and `grepHitRate` with `hit@k` in the human output.
- f34a965: Add `scripts/bench-corpora.mts`, which scores `lcm bench` across several local project corpora and pools the result. A single benchmark cannot separate a ranking improvement from noise: two changes that read as clean wins on one 13-question set did not survive pooling over 221 questions from eight corpora, one of them turning negative and pushing p95 past the latency budget. Retrieval ranking changes are measured here from now on.
- a3efd52: Make `lcm bench build --generator llm` produce recall questions instead of keyword lookups. Told only to "paraphrase", the generator returned the prompt's own vocabulary in a new sentence order: over 59 generated questions the mean share of question terms also present in their own prompt was 0.55, against 0.11 for the hand-written reviewed set, and search scored that easier set 0.75 where it scores the hand-written one 0.39. The generator is now handed the source prompt's distinctive words as words to avoid, and a generated question that still reuses more than half of them is rejected. On the same corpus that yields 60 questions whose overlap profile (mean 0.11, median 0.08) and difficulty (search 0.35) match the hand-written set — a benchmark large enough to tell a ranking change from noise.
- aa3fb84: Stop `lcm bench build` from sampling pasted tool output as a question source. A `role='user'` message often carries a grep listing, a `git push` transcript, or a directory listing rather than a human turn, and those read as highly distinctive — unique paths and hashes — so sampling favoured them: 55% of one 60-question set. A question generated from a listing asks about the listing, not about anything a person wanted to recall, and it is usually answerable from several sessions, which a single-label score counts as a miss.
- 9064418: Count only scorable sessions when `lcm bench build` detects repeated prompts. The uniqueness pass grouped over every conversation while sampling draws only from conversations with a nonempty session id, so a prompt held once by a real session and once by a session-less conversation counted as two and was excluded — though it is unique among the sessions a question can be scored against.
- cb22e30: Passive-learning events extracted from a user prompt now dedup on `(session_id, sha256(prompt))`, so a session where both the command hook and the function-hooks module run records each prompt once. A prompt carries no id both paths can see — the command hook's stdin has `prompt_id`, the module's `prompt.submit` has only the text — which makes the content hash the only shared key. Events sidecar schema v5 adds the `prompt_hash` column and its index; rows written earlier have no hash and never dedup against.
- 7fc82c0: Removed `compaction.leafTokens` and `compaction.maxDepth`, which nothing read. Tuning them changed nothing, which made them a trap. A config file that still sets them keeps loading; the values are ignored as before. `compaction.autoCompactMinTokens` stays: `lcm compact` uses it as the token threshold that picks which conversations to compact.
- f716898: Return linked source messages when lcm_expand reaches a leaf summary instead of an empty expansion. Preserve the requested depth for condensed summaries.
- fc436a1: Follow Claude Code's `$.fs` rename in the function-hooks module: `readFile`, `writeFile`
  and `listDir` became `read`, `write` and `list` in 2.1.267. The session claim had stopped
  being written, so the command hooks stayed active alongside the module.
- 89a9cba: Drop a query's function words in the language it is written in, not only in English. Query preparation stripped English stopwords and let every other language's through, so a pt-BR question carried "que", "como", "para" into the OR query and BM25 rewarded the long sessions that contain them everywhere; on the 74 pt-BR bench questions that alone cost 0.419 vs 0.486 hit@5. Instead of a fixed list per language, the daemon now generates a language pack (`~/.lossless-claude/languages/<tag>.json`) the first time a corpus in a new language is seen: after an ingest, a project with no recorded language and enough human turns is sampled, the model names the language, `meta.json` records it, and the pack is written once and reused. A pack applies to a query when two or more of its words are that language's function words. Packs are reviewable JSON; deleting one regenerates it. Mock or disabled summarizers skip the step, and a failing provider is logged once per project.
- 0532908: `LCM_HOME` moves everything lcm owns — the daemon's port, token and pid, the per-project databases, the events sidecars, the logs — somewhere other than `~/.lossless-claude`. Every path now resolves through `lcmHome()` instead of computing `join(homedir(), ".lossless-claude")` at 49 separate call sites, and the function-hooks module honours the same variable when it reads the daemon's address.

  This makes lcm runnable against a scratch directory. Until now the only way to point it elsewhere was to move `HOME`, which takes the host's own configuration with it — so a sandbox for lcm could not be built without breaking the tool under test.

- ff632eb: Refactored `hooks/lcm-hooks.ts` for readability, with no behaviour change: the 78-line registration body became one function per hook, the 65-line summarize poller split into fetching, classifying and serving, timings and the "command not found" exit code became named constants, and the config parse no longer swallows its error. The daemon's "no such route" log now names the route in every case.
- 4340c0b: `LCM_HOME` now reaches every path lcm resolves. Three sites spelled the root through an aliased import (`hd()`, `deps.homedir`, `_homedir2()`) and kept pointing at `~/.lossless-claude` regardless of the variable: purging all projects, one of the session-snapshot config reads, and `lcm doctor`, which now takes the lcm home as an injected dependency like it already took the user's home.

  Adds `LcmPaths`, one object holding every location derived from a single root, and a test that fails when the root is named outside the factory.

- fc436a1: Serve both MCP protocol revisions rather than only 2026-07-28. Claude Code opens a stdio
  server on 2025-11-25 unless `MCP_PROTOCOL_NEGOTIATION` is set to `auto`, so refusing that
  opening left the seven tools unreachable under the default. Both revisions now reach the
  same tools with the same results.
- 236a34a: Publish through npm trusted publishing (OIDC) instead of a stored token. 2FA-bypass automation tokens lose direct publish around January 2027, and the stored one had already expired. The workflow now authenticates as itself through the OIDC token it was already granted, and `docs/releasing.md` records the setup.
- 07aaacd: Leaf and condensed summaries now see the preceding chunk's summary. The compaction engine always passed it, but `SummarizeContext` had no field for it and no provider rendered it, so `<previous_context>` was always `(none)` on the daemon path and `/compact`'s `previous_summary` was accepted and ignored.
- 01e3078: The command hooks now stay silent only when the function-hooks module has actually claimed the session, not merely because `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set. The module writes `<tmpdir>/lcm-claim-<session_id>.json` at `session.start`, and `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` require both the variable and that claim before standing down. A module that fails to load no longer takes passive capture down with it: without a claim the command hooks record as they always did.
- 0d91af9: The function-hooks module now restores the session's memory itself, through a `prompt.context` block named `lcm`, instead of leaving it to the `SessionStart` command hook. The hook's other half — pruning the events sidecar and promoting what an earlier session left behind — moved to the daemon's new `POST /session-scavenge`, which the module fires without waiting; the command hook awaited it with the session blocked behind it. `lcm restore` stays in place for sessions without the module, and stands down when the module has claimed the session.

  The mark that tells a post-compaction restore from a fresh one now lives in the project database (`session_compactions`) instead of daemon memory, so a daemon restart inside the 30-second window no longer makes a restore replay the wrong content. `prompt.context` carries no reason for firing, which makes that mark the only signal the module has.

- 02722ac: Split `POST /restore` into one builder per client. Claude and Codex never shared an assembly — different tables, different blocks, different response bodies — but shared one handler and an `isCodex` boolean that branched in seven places across two hundred lines. The route now validates the request and dispatches to `buildClaudeRestore` or `buildCodexRestore`, neither of which knows the other exists. No behaviour change.
- 94c2ee2: Passive-learning events now dedup on `(session_id, tool_use_id)`. Both the command hook and the function-hooks module receive Claude Code's call id, so a session that runs both paths records each tool call once instead of twice. Events schema v4 adds the column and its index; a database written before it migrates on open.
- fc436a1: `npm run typecheck:hooks` refuses to run against declarations generated by a different
  Claude Code build. It held the module to an API three releases old and passed, which is
  how the `$.fs` rename reached a live session. It now names the installed version and says
  to restart before regenerating, since `/plugin-types` writes what its own session knows.

## [0.10.0] - 2026-09-08

### Added

- `llm.reasoning` config key: passes a reasoning object (e.g. `{"effort":"minimal"}`) to the `openai` summarizer, so OpenAI-compatible models like GLM Flash stop thinking at length before every summary (#342).
- `copilot-process` summarizer provider, backed by the GitHub Copilot CLI. `auto` resolves to it once a client identifies itself as `copilot`; today select it with `LCM_SUMMARY_PROVIDER=copilot-process` (#313).
- Normalized token cost reporting across all three process providers. `llm_usage_stats` now stores input, cached, and output tokens alongside the total, and `lcm import --replay` prints the breakdown.
- Native evidence search with session fusion (#321), FTS5-ready natural-language queries with stopword filtering and AND→OR fallback (#311), and `lcm bench build|run` for real-corpus recall benchmarks.
- Summarizer evaluation bench under `test/bench/` with OpenRouter, OpenAI-compatible and `claude-process` providers (#338).
- Resumable replay runs: manifest/ledger tables, resume planner, signal drain, `--restart` (#302, #326, #330, #331).
- Prompt-time memory injection budget and deduplication (#220), feedback-based reranking of recalled memories (#218), stale-memory review pipeline (#221), auto-promotion of reinforced passive-learning patterns (#217).
- `lcm stats` reports summarizer usage: calls, the token breakdown and the cost, shown once a call has been recorded.

### Changed

- `codex-process` reads its usage from `codex exec --json` instead of the stderr banner, gaining an exact input/cached/output split (the stderr total remains a fallback for older Codex builds).
- `claude-process` reads `--output-format json`, so it now reports token usage and cost.
- The `claude-process` summarizer subprocess is isolated from user plugins, MCP servers and settings (#328).
- Summary output cap follows the requested target instead of a fixed constant (#336).
- `lcm daemon start` is idempotent; `stop`/`restart` added; the daemon carries a content-hash build fingerprint and `lcm doctor` checks the real plugin install (#325, #329).
- Tag prefix `category:` normalized to `type:` everywhere (#212, #219).
- Token usage reporting extended to the HTTP summarizer providers. `openai` and `anthropic` now emit the same normalized accounting, so the default path off the Claude CLI no longer records a summarizer that appears to consume nothing; against an OpenRouter base URL the real charged cost is requested and recorded (#345).
- `llm_usage_stats` stores the reported cost in `cost_usd_total` alongside a `calls_with_cost` counter. An absent cost stays NULL and prints as `unknown`, never `$0.00`, and a partially priced run reports "N of M calls priced" so it cannot pass for a complete total (#351).

### Fixed

- Summarizer fails on empty model output instead of echoing the input back as a summary (#341).
- Hooks: `PostToolUseFailure` registered, hook POSTs bounded by deadlines, sensitive paths screened on tool failures and in the Bash command prefix, never exit non-zero on malformed stdin (#334).
- SQLite `datetime('now')` columns read as UTC.
- `DaemonClient` uses `node:http`, removing undici's 300 s headersTimeout false failures on `/compact`.
- `lcm_search` natural-language queries no longer return empty on AND-only FTS5 matching (#311).
- Restore no longer echoes CLAUDE.md on startup/resume, captures it once when cwd is `$HOME`, and shares SQLite connections throughout (#271).
- VS Code and Codex `lcm` workflows restored (#227); plugin hook commands point argv[1] at the CLI so they actually run (#272).
- Session-end fire-and-forget requests send the daemon auth header.
- `llm.reasoning` is rejected at config load unless it is a JSON object, instead of failing later as an opaque provider HTTP error inside the unattended `/compact` route (#343).
- Search no longer hides summaries. Session fusion emitted one message per matching session and exhausted the limit on its first pass, so no summary could surface once the session count reached the limit, however well it scored (#353).
- The recall gate runs the daemon's `/search` path instead of concatenating candidate lists by hand, and covers the message/summary mix that session-level recall is blind to (#356).

## [0.8.1] - 2026-03-30

### Added

- User notification when sensitive data is filtered from LCM history (closes #178)

### Fixed

- Compact-restore test isolation — eliminate tmpdir() contamination (#184)

### Changed

- Quality-gates CI: label-based merge requirements (#185)
- autoimprove.yaml: add missing forbidden paths (closes #182) (#183)

## [0.8.0] - 2026-03-28

### Added

- Connection pooling for sidecar EventsDb (issue #131)
- Portable knowledge export/import commands — `lcm export`, `lcm import-knowledge` (issue #132)
- Pool stats observable — `lcm stats --pool` + `GET /stats/pool` daemon endpoint
- AR coverage gate CI workflow
- Copilot auto-review on all PRs

### Fixed

- `post-tool` command not registered in CLI dispatcher (#162)
- Security: upgraded hono, rollup, picomatch (3 high CVEs)
- Security: CodeQL hostname regex escaping + sanitizeError in daemon
- Atomic meta.json write in `importKnowledge` — prevents corruption on crash mid-write
- `redaction_stats` CHECK constraint migration for v0.7.0 → v0.8.0 upgrades (adds `'gitleaks'` category)

## 0.1.0

Initial release under `@lossless-claude/lcm`.
