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

Paginated Codex rewrites resume capture only for a proven subagent tail match. Other paginated recovery mismatches are recorded once as terminal session guards and reported by `lcm doctor`; later capture requests skip the file. Guards record the recovery-rule version: a rule change retries each older guard once on the next capture, including a scan or import; an unrelated upgrade keeps it. Clear terminal Codex guards in the current project with `lcm import --provider codex --retry-blocked`; add `--session <id>` to clear only that session, or `--all` to clear guards in every project with a project record. `--retry-blocked` requires `--provider codex` and cannot be combined with `--replay`, `--rebuild` or `--dry-run`, or with `--all` and `--session` together. The next capture rechecks alignment under current redaction rules without deleting messages or summaries; a remaining mismatch is blocked again and recorded once. Doctor names this command. See [Codex capture rules](import.md) and [the design](design/codex-paginated-history.md).

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

### Compaction shadow artifacts

The daemon exposes authenticated compaction shadow artifact routes, but no live
shadow hook or model executor is enabled. Native compaction and restore keep their
existing behavior. Artifacts live in each project's `compaction-shadow/` directory
under the lcm home, use Capture's scrubbing rules, and expire after 30 days.
Recovery skips linked project/shadow/cut directories and checks real-path
containment before recursive cleanup. Correlation identifiers are validated and
preserved exactly; sensitive identifiers are rejected. Admission retries compare
a digest of raw identity fields, so redaction cannot hide a changed request.
Native tails must match frozen engine handles in order, with the same role and
current-rule scrubbed text; conflicting deliveries return HTTP 409.

`bench-corpora.json` is optional for shadow admission: a valid existing exclusion
skips a project's cuts before Capture with HTTP 200 and
`{ admitted: false, reason: "excluded" }`. A missing policy leaves admission
available; an unreadable or invalid policy refuses admission with HTTP 200 and
`{ admitted: false, reason: "policy-unavailable" }` and logs a warning.
Corpus discovery skips non-directory project entries and unreadable metadata.
Offline evaluation requires a valid explicit policy and applies its
exclusions before loading corpus content. See
[compaction shadow artifacts](design/compaction-shadow.md) for wire fields,
accounting, retention and privacy.

The repository's read-only phase-1 evaluator requires a built checkout and an
explicit local output directory:

```bash
LCM_SKIP_CACHE_SYNC=1 npm run build
node --experimental-strip-types scripts/eval-compaction-shadow.mts --home /path/to/lcm-home --output /path/to/new-report
```

The selected home must contain a valid `bench-corpora.json`. Held-out projects are
reserved, and excluded projects are filtered from metadata before corpus reads.
Present policy exclusion/holdout fields must be lists; null is invalid.
Optional `--transcripts` points to a JSON list of `{ cwd, sessionId, path }` entries
for exported native transcripts; otherwise allowed projects' Claude transcript
directories are discovered. Ownership metadata is scanned on every row; an omitted
`cwd` inherits the prior row's. Any excluded cwd removes the whole session,
including paired shadow evidence. A directory or manifest label cannot establish
ownership. Every recorded session id is validated against the supplied label
before acting on exclusion; mismatches invalidate the source, and exclusions
block its recorded session ids. Stored tails that conflict with the frozen
messages also invalidate a cut. Malformed exported identifiers, including non-UUID row ids, invalidate
the source. `--seed` fixes selection, `--limit` defaults to 30 cuts,
and `--rates` supplies a frozen model/cache rate table. No models are called.
Reports distinguish missing evidence and unknown cost; continuation judging is a
phase-2 stub. The output directory must not already exist.

### Project store hygiene

`lcm doctor` counts project directories without a `meta.json` file and directories
whose recorded absolute cwd no longer exists, including ordinary missing
checkouts. Cwd checks run asynchronously with a 1 s deadline per stat and at
most four outstanding stats. A timed-out stat keeps its concurrency slot: if all
slots time out, remaining cwds are left unchecked. Doctor reports timed-out,
unattempted and unreadable cwds separately from missing cwds, warns about them,
and continues reporting its other checks. Unchecked cwds never count as missing
or stale. Corrupt or unreadable records are not counted as missing files.
Missing-file counts are read-only and do not change the check's status; cleanup
remains an explicit operator action.

`lcm doctor` reports stores whose recorded working directory no longer exists and
was under a system temporary directory (under its path or its resolved real path,
such as macOS `/private/var/folders`), or has an `e2e-test-*` or
`lossless-ingest-*`, `lossless-compact-*`, or `lossless-status-*` path component.
Existing directories and ordinary missing checkouts are retained. Invalid or
unreadable project records are counted as not checked and skipped by cleanup;
the cleanup preview lists each one. Normal doctor output shows at most 20 entries
per store list, followed by “... and N more”. Use `lcm doctor --verbose` (or `-v`)
to review every store and all reported orphan-summary ids.

Doctor also counts databases without a valid absolute cwd in their record and how
many hold promoted memories (including archived memories and feedback signals).
Unreadable databases are reported separately with unknown memory contents.
The cleanup preview offers a recoverable cwd when structured rows carry one, or
a project id that maps to a known project record. It offers no suggestion when
the evidence names multiple working directories. Review and restore these project
records manually; both preview and apply retain record-less stores and their
event sidecars without changing their records or databases.

Review the cleanup preview, then hold the daemon offline before applying it:

```bash
lcm doctor --cleanup-stale-projects --dry-run
lcm daemon stop --hold
lcm doctor --cleanup-stale-projects --apply
lcm daemon start
```

An active hold blocks automatic starts and `lcm daemon restart`. A refused restart
exits non-zero and reports the hold's process id, reason and expiry. Release a hold
explicitly with `lcm daemon start` or `lcm daemon restart --release-hold`; otherwise
it remains in place until expiry.

Cleanup defaults to a dry run even without `--dry-run`. It runs separately from
normal diagnostics, so a preview neither starts a daemon nor applies other doctor
repairs. `--apply` requires an active hold and refuses a running daemon or retained
live CLI database activity. It verifies the hold before listing project records,
before each store's batch, and before each move. If the hold is lost, cleanup stops
and reports every path already moved and its trash location. Those paths remain
in trash for manual restoration under a new offline hold; the group-index
transaction is rolled back. It moves
each eligible project directory and its events database, including WAL/SHM files,
to `<lcm-home>/trash/projects/<batch>/`, and removes that project's references from
`group-index.sqlite`. It never deletes the stored data. The command prints the
trash directory; there is no automatic trash purge. To restore a store, hold the
daemon offline, move its project directory back under `projects/` and its files
from the batch's `events/` back under `events/`, then start the daemon. Once the
recorded working directory exists again, project identity backfill rebuilds the
group-index references.

Doctor also reports orphan-summary counts and ids per store. An orphan is a
summary that is absent from context and is not a source of another summary.
The check opens existing databases read-only without migrations. One cheap query
skips an empty `summaries` table before inspecting orphan relationships, including
in stores without a project record. Unreadable or unsupported databases are
reported as not checked. It offers no automatic repair
and preserves summaries and context.

### Manual memory attribution repair

`lcm doctor --repair-manual-attribution` previews attribution for every active
promoted memory whose `session_id` is `"manual"` in existing project stores.
It scans raw Claude Code project transcripts, including discovered subagents,
and Codex sessions and archives. Only tool calls whose name ends in `lcm_store`
count: Claude `tool_use` inputs and Codex `function_call` arguments or
`custom_tool_call` inputs, with a string `text` or `content` argument.
Stored message mentions are not evidence. Matching replaces NUL with U+FFFD,
normalizes Unicode to NFC, collapses whitespace and trims both texts.

A matching call counts for a memory only when the store holding that memory captured
the call's session (`conversations.session_id`). Exactly one such session is
**attributable**; repeated calls or transcript copies of that session count once.
Several such sessions are **ambiguous**. A call found only in sessions other stores
captured is **matched outside this store**, and no matching call anywhere is
**unmatched**. These three outcomes leave the memory unchanged. A store that cannot be
read or written is reported as skipped, and the other stores are still processed.
The session is the one named by the transcript file that holds the call: a call made
inside a subagent's transcript is attributed to that subagent's session, whereas a
live `lcm_store` records the parent's `CLAUDE_CODE_SESSION_ID`.
Archived memories and memories already attributed to a session are left alone.

```bash
lcm doctor --repair-manual-attribution             # preview; --dry-run is optional
lcm daemon stop --hold
lcm doctor --repair-manual-attribution --apply
lcm daemon start
```

The preview opens databases read-only, performs no migrations or repair writes,
and neither changes project records nor starts a daemon. Apply requires an active
offline hold and refuses a running daemon or live CLI database activity. Before
changing each store, it retains a consistent full database backup, WAL data
included, at the printed `db.sqlite.bak-manual-attribution-*` path. Updates are
transactional per store and change only `session_id`; content, tags, confidence,
timestamps, depth, project and summary provenance and the full-text index stay
as they were. Repeating apply does not select repaired memories or create a backup
for a store with no unique matches. Backups are not automatically deleted.

To revert, hold the daemon offline, replace that store's `db.sqlite` with its
printed backup and remove its `db.sqlite-wal` and `db.sqlite-shm` before restarting.
This restores the whole project database, including its old session attribution;
later writes would also be reverted. Attribution repair cannot be combined with
`--cleanup-stale-projects`, and `--apply` cannot be combined with `--dry-run`.

The test harness isolates both `LCM_HOME` and `HOME`, retains the OS user's real
lcm home independently of those variables, rejects a temporary base inside that
protected home before allocating test directories, and refuses that home whenever lcm
resolves a home or builds its storage paths. The guard covers normalized paths,
symlink aliases and inherited CLI child processes, in addition to the test
harness's default-daemon-port guard. `LCM_TEST_REAL_HOME` carries the protected
root in test processes; it is set by test setup, not user configuration.

## Daemon log

The daemon writes one JSON record per line to `~/.lossless-claude/logs/daemon.log`. Every record has `ts`, `level` and `event`; the rest are fields such as `route`, `status`, `cwd`, `session_id`, `reason` and `err`. `lcm doctor` reads it for the `daemon-log` check. To answer "why did compaction not run for this project?", filter it by `cwd`:

```bash
jq -c 'select(.cwd == "/path/to/project")' ~/.lossless-claude/logs/daemon.log*
```

- **Requests**: one `request` record per request, with its route, status and duration. `/session-end`, `/compact` and `/session-start-compact` are logged at `info`, so a `/session-end` with no `/compact` after it is visible. `/tool-event`, `/health` and `/summarize-jobs/*` are logged at `debug`. A 5xx is logged at `error`, and a 4xx at `warn`. At `debug`, each request also gets a `request.start` record (route, `cwd`, `session_id`) when its body has been read, so a request that never completes still leaves a trace.
- **Outcomes**: `compact.done`, `compact.skipped` (`reason`: `already-compacting`, `disabled`, `no_work`, `auto-compact-disabled`), `compact.sweep`, `promote.done` and `session_end.ingested`.
- **Transcript scan**: `scan.missing_cwd` (`debug`) reports the `sessions` skipped because their working directory no longer exists, once per scan with skipped candidates. They are eligible again when the directory returns.
- **Failures**: `ingest.failed`, `route.failed`, `compact.failed`, `promote.failed`, `daemon_request.failed` (a follow-up request the daemon could not send to itself), `ingest.subagent_failed`, `daemon.crash` (with its scrubbed stack), `summarizer.fallback` (`from_provider` produced no summary, so `to_provider` summarized instead; the same endpoint at both ends when it is asked again after stopping at the output cap), and `summarizer.endpoint_unavailable` at startup, once per named endpoint left out because `missing_env` is unset.
  Errors serialized in `err` include a scrubbed `stack` when lcm frames are available: only source-relative file locations, lines and columns are retained, without error headers, function labels, dependency frames or absolute path prefixes. Compiled code uses `src/*.js` locations; a plugin bundle retains only its own `bundle/*.js` locations. SQLite errors include `code` and, when present, numeric `errcode` and scrubbed `errstr`. Their `message` is omitted because it can contain SQL or captured text; SQL parameters and other error properties are not serialized. Stack and string fields follow the project scrubber's existing omission rules while its patterns are pending or unavailable.
- **Continuity**:
  - `daemon.start` records `prev`: `clean` when the previous daemon left a `daemon.stop`, `unclean` when it did not, and `none` for the first log.
  - `daemon.stop` is written on idle shutdown, SIGTERM, SIGINT and an uncaught exception. `lcm daemon stop` sends SIGTERM.
  - `log.gap` records how many records were dropped while appends were failing, and over what period.
  - `daemon.stalled` (`warn`) is written once the event loop has been blocked for more than 5 seconds, when the block ends: a blocked daemon answers nothing, `/health` included, and cannot log until it is free again. `ms` is how long the block lasted. There is one record per request or named background task that could have been in flight during the block, with its `route`, `cwd`, `session_id` and `started_at`; the ingest behind `/session-end`, the periodic transcript scan and the tool-call model backfill `/ingest` runs after replying are named `session-end:ingest`, `scan:transcripts` and `ingest:backfill`. Nothing ends while the loop is blocked, so a response closed or a task ended by the time the next monitor tick was due (one second after the previous tick) ran before the block and is not named, even when no tick removed it from the in-flight set in between. A request or task started within one tick interval before the reporting tick is not named: it may have started after the block ended, while queued callbacks ran before the report. A request whose response closes in that interval remains named if it started earlier. `GET /summarize-jobs/next` is a long poll that is always in flight by design and is never named as a cause: when it (or nothing) is all that was in flight, one record without a route is written instead, with `longPollCount` when any were pending.

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

`LCM_LEAF_MIN_FANOUT` (default `3`) also sets the minimum number of depth-0 summaries for condensation. `LCM_CONDENSED_MIN_FANOUT` (default `2`) sets the minimum for summaries at depth 1 and above.

Non-positive or non-finite fanout values use these same defaults (`3` and `2`), replacing the older engine fallbacks of `8` and `4`. The unused hard-trigger fanout setting has been removed: no route selected that mode, and forced sweeps use the same depth-based fanout as other sweeps.

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

### Session commit references

`commits.enabled` defaults to `true`. The explicit
`lcm import --backfill-event-times` operation runs transcript repair, then a local
commit pass under the project queue and mutation lease. Disable the commit pass with:

```json
{ "commits": { "enabled": false } }
```

The setting leaves transcript repair, existing references and anchors intact.
There is no automatic git scan or remote fetch. References require a hash in stored
`git commit` output (normal, root-commit or detached-HEAD), or a commit's
`Claude-Session:` trailer equal to a web URL declared by that session's main-chain
Claude `remote_session_change` attachment. Hook capture, import and the transcript
backfill store declarations in `session_web_urls`; incremental hook reads record new
declarations too. Sidechain attachments declare nothing and attachments create no message.
Stored message content, tool output and prompts are never scanned for trailer URLs.
Several sessions declaring one URL all link. Trailer evidence creates one link per session and commit;
its representative message is never used for dating. Each run scans trailer history once
per session and exact URL. Stored references are refreshed at the start of the run;
trailer discovery does not verify already linked commits again. Only messages whose own commit
output names exactly one distinct, resolvable commit receive its committer time when
unknown, recorded with source `commit`; multiple outputs stay unknown. The first enabled
pass repairs legacy duplicate trailer links and trailer-only or ambiguous anchors once,
recomputing affected summary bounds. The author date is reference metadata only. Hashes from `git log`, `git show`,
bare hex lines and hex-looking words create no reference or event-time anchor. Describe shows the references
on sessions, summaries and timeline nodes. See [import repair](import.md#event-timestamps-and-existing-history).

A separate one-time identity repair deletes all existing `session-trailer` links and
re-derives them from declared URLs. A session with no declaration keeps no trailer link.
This repair changes no event times or summary bounds.

### Project timeline opt-in

`timeline.generationEnabled` gates manual and automatic model generation and
defaults to `false`:

```json
{ "timeline": { "generationEnabled": true } }
```

`lcm timeline enable` installs tracking triggers and bootstraps metadata without
calling a model. Tracking is off until explicitly enabled: migration installs no
timeline triggers while off, and restores missing or outdated definitions while on.
`lcm timeline disable` stops project generation while retaining
tracking. `lcm timeline teardown` removes dependent references and tracking triggers
while retaining historical nodes. Before downgrading, use
`lcm timeline teardown --remove-nodes` to delete all owner summaries and timeline
node rows in the same transaction, detaching edges first and retaining session
summaries and messages. A downgraded lcm promotes retained timeline nodes at every
session end, even after teardown without the flag. Re-upgrading archives those
memories: migration matches `source_summary_id` against owner summaries, or
`session_id = 'lcm:project-timeline'`. These are never legitimate promoted memories.
Already-current migrations acquire no write lock unless repairs or archival are needed.

`lcm timeline settle --calls 10` generates within a summarizer-call budget;
`--calls 0` refreshes dirty-session metadata without a model, even when generation
is disabled. `--reconcile full` explicitly repairs triggers and checks conservative
conversation aggregates in resumable pages. Source text is read by id for ready
units and never stored in a separate cache.
Counter conflicts leave their sessions dirty for the next settle while other
sessions and independent units proceed. The report stops with `conflict` only
when nothing else could proceed.

Automatic work checks each project every 30 seconds and requires tracking and project
generation enabled. During bootstrap, each tick seeds at most 256 sessions without
model calls and yields. After bootstrap, generation waits for 60 seconds without
a newer session bump. Each tick runs at most one unit.
Unclaimed pool jobs stop timeline settle as `busy`, leaving failure counts, retry
deadlines and node flags unchanged for the next tick. Claimed jobs that time out
remain model errors.
Model errors and publication conflicts back off exponentially
from one minute to one hour; eight failures park a unit until a contributing session changes. Only
the latest replay run can hold work, and that hold expires five minutes after its
last progress. Ordinary ticks drain persisted work once generation is on and replay
no longer holds it; ledger inserts execute no timeline completion trigger or manifest scan.

Timeline generation uses the existing `llm.provider` chain. It accepts
`session-pool` and named OpenAI or Anthropic HTTP endpoints with `maxConcurrent`.
Both admit live work first, replay/background second and timeline last, FIFO within
each class, without interrupting jobs already running. A timeline job never starts
while a higher-class job is waiting. Process, live-session and unbounded HTTP
providers refuse timeline generation because they cannot enforce that order.
Endpoints with missing environment variables are skipped; at least one provider
must remain runnable, and every runnable HTTP endpoint must have `maxConcurrent`.

To use only dedicated workers, select the pool and disable its implicit process
fallback:

```json
{
  "llm": { "provider": "session-pool", "fallbackProvider": "disabled" },
  "timeline": { "generationEnabled": true }
}
```

This also selects the pool for live compaction. For HTTP fallbacks, select
`llm.provider: "session-pool"`, declare bounded endpoints in `llm.providers`,
and list them in `llm.fallback`; the pool needs no endpoint entry. Timeline pool
jobs belong to the reserved `lcm:project-timeline` session, never a real session.
Their presence does not extend live or replay claim or completion deadlines.

Generation requests check admission before database work and return HTTP 409 with
configuration guidance, printed verbatim by the CLI. Refusals never flag model
failures, back off or park units; zero-call reconciliation remains available.
The first admitted generation settle releases legacy backed-off or parked units
once, including those blocked by missing environment variables. Legacy failures
lack a recorded cause, so legacy model failures also receive one retry. Later
failures retain their persisted backoff and parking.

`lcm status` and `lcm doctor` separately report ready timeline units (`pending`),
months awaiting replan (`replanMonths`) and parked units (`parked`), plus stale nodes and dirty sessions,
without migration or settle. Ready units include those in months awaiting replan
and those waiting for retry; parked units are excluded from pending. Doctor warns
when units are parked: a contributing session must change, then
`lcm timeline settle` reconciles that change and releases them. Timeline counts read
indexed tables, including dirty sessions not yet flagged. Ordinary counts remain available
on unmigrated read-only stores. Failed ordinary counts print `unavailable` in the
CLI; zero remains zero. Ordinary counts use SQLite table counts minus indexed owner counts.
Historical timeline nodes remain readable by id unless explicitly removed.
Doctor also checks tracking/detach SQL in `sqlite_master` read-only and reports
missing or outdated triggers with `lcm timeline settle --calls 0 --reconcile full`.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

The project timeline uses the same limit for digest leaves and period chunks.
It also closes a chunk at a UTC month change and keeps existing summaries
indivisible. Changing the limit changes the timeline generator revision; settle
flags prior nodes stale and publishes replacements.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

### Leaf summary input

Leaf summaries receive timestamped messages and the preceding summary for
continuity. When the window's stored shell calls establish error→fix pairs or
block reasons, the same summary call also receives a `tool_context` JSON block.
It asks the model to keep each entry briefly: for every pair, the failed command
and the command that worked after it; for every block, the command and its masked
reason. `errorFixPairs` names the failed and successful commands;
`blocked` contains distinct `{ command, reason }` entries, with the command read
from its stored call and the reason masked. Each failure, fix and block belongs
only to the command it names. This uses the window's own calls, independently of
the project's published tool lessons, and adds no model call.

The structured JSON is capped at 8192 UTF-8 bytes. Each command and reason is
capped at 2048 bytes, preserving UTF-8 boundaries and ending with `[truncated]`
when capped, like stored call inputs. Complete entries that do not fit are
omitted; `omitted` reports their count. The fixed prompt instructions are
outside this byte budget. With no pairs or block reasons, the leaf prompt is
unchanged, including in aggressive mode. These limits are fixed, not config
settings. See [the eval bench](summarizer-bench.md) for retention checks.

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

Use [the summarizer comparison command](summarizer-compare.md) to compare named
endpoints on one stored session before selecting a model. It writes local JSON
and HTML reports using production compaction in memory; the project database is
read-only.

```sh
lcm eval summarizer --session <id> --models local,hosted --runs 2 --out ./comparison
lcm eval summarizer --session <id> --models local --project /path/to/project --no-planted
```

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
- `session-pool` (dedicated interactive workers, see below)

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
| `timeoutMs` | `openai`, `anthropic` | Deadline for one HTTP request, in positive integer milliseconds. Default: 600000 (10 minutes), the SDKs' own default: a slow local model can take minutes over one summary. Set it lower for an endpoint that should fail over sooner. |
| `maxConcurrent` | `openai`, `anthropic` | Maximum simultaneous HTTP requests to this named endpoint across the daemon, as a positive integer. Unset means unlimited. |
| `body` | `openai`, `anthropic` | Extra request fields; see [Request body](#request-body) |

A process endpoint accepts only `type` and `model`: its CLI authenticates through its own login. Any other field is rejected at config load, on every endpoint.

The same default deadline applies to the flat `openai` and `anthropic` providers. lcm owns HTTP retries; SDK retries are disabled. A timed-out request skips further retries of that endpoint and advances the chain, because a server that accepted a request but never answered is unlikely to answer the same request on retry. Other transient HTTP failures still use lcm's retry loop.

OpenAI and Anthropic requests use a buffered Node HTTP transport: there is no separate 300-second headers or body timeout. HTTPS uses Node’s default certificate trust, including private CAs supplied through `NODE_EXTRA_CA_CERTS`. Proxy routing is not supported by this transport. Redirects are not followed either: `baseURL` must be the endpoint's final URL, scheme included, because a redirect response fails the request with its 3xx status.

When `maxConcurrent` is set, the limit is shared by every project and session using that endpoint name, including separate summarizer instances. Extra calls wait in three classes: live, background and timeline, admitted in that order and FIFO within each class, without interrupting a request already running. Background is admitted whenever no live call is waiting; timeline waits until both higher classes are empty. This admission order applies to the OpenAI and Anthropic HTTP adapters; see [timeline endpoint ordering](#project-timeline-opt-in) for the other providers. Priority is strict: background progresses between finite bursts of live compaction, but can wait indefinitely under continuous live saturation. Live compactions follow session lifecycle events, and each SessionStart catch-up sweep is capped by `compaction.autoCompactSessionStartMax`.

PreCompact is live (`capture_required`, or OMP's `precompact_verified` after separate capture). SessionEnd, including its legacy hook fallback, and SessionStart catch-up explicitly send `work_class: "live"` alongside `skip_ingest: true`. Other `skip_ingest` compactions — `lcm import --replay`, batch `lcm compact`, and `lcm compact --replay` — are background. Direct compactions and summarizer calls without a class default to live. The class travels with every summary attempt, including retries and fallback endpoints.

A live call waits at most `timeoutMs` (or its 600000 ms default) for a slot; if that wait expires, the chain can try its next endpoint. Background slot waits have no timeout. Once admitted, either class's HTTP request gets its full, separate `timeoutMs` deadline. PreCompact's 120-second hook deadline bounds how long the hook waits for `/compact`; the daemon continues its work after the hook stops waiting, so the live slot bound prevents that work waiting indefinitely behind an overloaded endpoint. Replay's `/compact` call has no overall client timeout.

A timed-out request frees its slot when lcm abandons it, but a server that keeps generating after the client disconnects is still busy, so the next admitted request overlaps it. Set `timeoutMs` well above the time the server needs for one summary, so timeouts stay rare.

A local server that processes one generation at a time can use one slot:

```json
{
  "llm": {
    "provider": "local",
    "providers": {
      "local": {
        "type": "openai",
        "model": "<local-model>",
        "baseURL": "http://localhost:8080/v1",
        "maxConcurrent": 1
      }
    }
  }
}
```

- **Names.** An endpoint's name is what its usage is recorded under in `llm_usage_stats`, and what `llm.provider`, `llm.fallback` and `LCM_SUMMARY_PROVIDER` select it by. It is made of letters, digits, `_`, `-` and `.`; the provider values listed above are reserved.
- **Selection.** `llm.provider` names an endpoint, or `session`, `auto` or `disabled` (`auto` when unset). `llm.fallback` names endpoints only, each once. Nothing else is added: a chain whose last link fails fails the pass.
- **Selection by environment.** `LCM_SUMMARY_PROVIDER` replaces `llm.provider` and keeps `llm.fallback`; an endpoint it promotes out of `llm.fallback` still runs once. It also accepts a provider type such as `openai` when exactly one endpoint has that type.
- **Unset variables.** The daemon expands `${NAME}` from the environment of the process that started it, which may be any session's. An endpoint whose `apiKey` or `baseURL` names an unset variable (or an `anthropic` endpoint with no key and no `ANTHROPIC_API_KEY`) is left out of the chain, and the rest of the config loads; every other config error still stops the load. With every link of the chain left out, each summary fails with an error naming the endpoints and their variables. To see it: the daemon log's `summarizer.endpoint_unavailable` warning at startup, the `summarizer` field of the daemon's `/health` answer, and `lcm doctor`, which warns per endpoint left out and fails when none of the chain can run. Export the variable where the daemon starts, then run `lcm daemon restart`.
- **Both forms.** With `llm.providers`, a non-empty flat `llm.model`, `llm.baseURL` or `llm.apiKey`, and any `llm.reasoning` or `llm.fallbackProvider`, are rejected; the empty strings `lcm install` writes are ignored: each endpoint holds its own settings and inherits none from another. Without `llm.providers`, `llm.fallback` is rejected and the flat form works as described in this section.

Each link is tried once per summarization, after its own retries, plus one retry when its answer stopped at the output cap (see [Cut-off and empty answers](#cut-off-and-empty-answers)). The chain moves to the next link when the current one:

- is the session and does not answer (no module loaded, session gone, timeout, error);
- returns an answer lcm rejects (see [Cut-off and empty answers](#cut-off-and-empty-answers));
- refuses the key (401 or 403, not retried), or its account cannot pay (402, not retried);
- cannot be reached, times out, or is still unavailable after its retries (408, 429, 5xx);
- is a process provider whose CLI run fails.

Anything else fails the pass without trying the next link: a request the endpoint refuses as invalid (400, 422) — except the retry of a cut-off answer, whose larger cap may exceed the model's output limit —, a cancelled request, a client library that is not installed, or any error lcm does not recognise. When every link fails, the chain throws one error naming each link's failure. Compaction recovers from output cuts by splitting the source chunk and ultimately truncating a single source; other exhaustion fails the pass. Every attempt is recorded under its endpoint's name, so an answer DeepSeek cut off counts as a failed `deepseek` call even when OpenRouter's answer is the one stored. An HTTP or process attempt that failed before any usage came back (a refused key, a failed CLI run) is recorded as a failed call with no tokens, and an answer that carried no usage is still attributed to the endpoint that gave it, with that endpoint's configured model. `lcm doctor` checks the CLI of every process endpoint the chain lists.

### Session provider

`llm.provider: "session"` asks the live Claude Code session that owns the transcript to run each summarization through its own client, via lcm's function-hooks module (loaded when Claude Code's mods are on; see `docs/hook-protocol.md`). Leaf chunks go to `haiku` through `$.model.complete`; condensed nodes go through `$.model.fork`, so the session's own model sees the whole conversation. Tokens are charged to the session's Claude account.

```json
{ "llm": { "provider": "session", "fallbackProvider": "claude-process" } }
```

- A job has 20 s to be claimed, then a fresh 60 s completion deadline from claim. `llm.fallbackProvider` answers an unclaimed or expired job, or a session error (including spend cap reached or an answer holding only whitespace); late replies are discarded. Any provider except `session` and `session-pool` is valid. When absent, the `auto` resolution above applies. Ordinary compactions honor the provider named in `llm.provider`; an explicit requester-first rendered compaction prepends its requesting session as described below.
- Claude PreCompact has a 120 s outer hook window and a 120 s `/compact` request timeout. The 60 s completion allowance leaves headroom for a leaf answer, but capture, multiple jobs and fallback share the outer window. Ordinary daemon compaction has no overall completion timer and continues after a caller disconnects; the opt-in rendered path uses `compaction.hookDeadlineMs`. SessionEnd waits only for acknowledgement; its subsequent compaction and the SessionStart sweep are fire-and-forget. An absent session module still falls back after 20 s: the longer completion deadline helps only claimed jobs. See [live compaction bounds](design/session-summarizer.md#live-compaction-bounds) for the code references and other host paths.
- With `llm.providers`, the session is the first link of the chain above and `llm.fallback` replaces `llm.fallbackProvider`; there is no implicit `auto` fallback.
- The module stops serving jobs when recorded output reaches `sessionSummarizerMaxOutputTokens`; set it in the plugin's `userConfig` (default 50000, 0 disables serving jobs). `$.model.complete` is limited to the remaining allowance, but `$.model.fork` has no output-token limit and can overshoot on its final call.
- Usage is recorded as `session:haiku` or `session:fork`; current hosts report exact `complete` usage, while older text-only results use estimated token counts recorded in `llm_usage_stats.calls_estimated`.

### Rendered Claude compaction

`POST /compact` with `render_context: true` waits for verified Capture and a real
summary sweep, then returns a complete, strictly fitted conversation window.
`compaction.hookDeadlineMs` bounds the whole opt-in operation, including admission,
Capture, requester jobs, configured-provider fallback and rendering. It defaults to
1800000 ms (30 minutes) and accepts a positive integer up to 2147483647. Increase it
for conversations requiring many sequential summary calls. Expiry returns HTTP 408
with a non-ready context, cancels pending jobs and prevents late summary publication;
previously committed passes remain stored. Database resources and the session guard
remain owned until outstanding operations settle.

The wire field `compaction_summary_model` accepts `haiku`, `sonnet`, `session`, or
`pool` and defaults to `pool`. The first three require `summary_via_requester: true`
and `requester_session_id` equal to the source `session_id`. They prepend requesting-session
jobs to the configured provider chain without changing global provider selection.
`pool` retains the configured pipeline and its existing cost profile. The opt-in
`sonnet` requests Sonnet for **every leaf and condensed node** of the sweep; on large
conversations these calls consume substantial real session quota. `haiku` uses Haiku;
`session` requests the session's model through a fork. A failed or unclaimed requester
job falls back to the configured chain, so its actual model/cost may differ.
`pool` creates no requester jobs: it preserves the configured chain and its cost
profile, including Haiku workers and fallback when that is the configured provider.
The daemon contract carries the model choice; exposing it as a plugin setting and
serving compaction-purpose jobs are responsibilities of the calling module.

Requester jobs keep the 20 s claim window and use `llm.poolCompletionMs` as their
claimed completion allowance (3 minutes by default); ordinary session jobs retain
60 s. Compaction jobs carry `timeoutMs` and an operation `deadlineAt`, so the caller
bounds a model completion to the smaller remaining allowance. The operation owns its
overall cancellation timer. Requester jobs are separate from worker-pool jobs and
cannot be claimed or answered through a worker identity. The existing session output
cap still applies in the serving module; Sonnet usage is labeled `session:sonnet`.

The complete answer budget is separate from `restoration.maxInjectedMemoryBytes`.
A caller reserves its handled tail and passes `context_budget_bytes` (1 through
65536); the daemon counts the full marked/fenced context in UTF-8 bytes, includes
all raw items even when they overlap the caller's tail, and rejects overflow rather
than truncating it. See [the wire contract](hook-protocol.md#complete-compaction-context).
The command PreCompact path keeps its existing 120 s client/host deadlines.

### Summarize worker pool

`session-pool` sends the same rendered prompts to dedicated interactive workers.
Its queues are separate from `session`: an ordinary session can claim only its own
jobs, and a worker can claim only pool jobs, one at a time. Pool claims serve live
compaction first, replay/background second and timeline last, FIFO within each
class. Calls without a class default to live. Running jobs finish without
interruption; queued lower classes can expire under continuous higher-class work.
A job no worker claims
within 20 s, or a claimed job not answered within `llm.poolCompletionMs` (default 180000 ms), falls along the
configured provider chain; late replies are discarded. Unclaimed timeline jobs instead
stop as `busy` so the next tick can retry without backoff. With flat configuration it uses `llm.fallbackProvider` (or `auto` when
unset); with named endpoints it uses `llm.fallback`. Set `fallbackProvider` to
`disabled` to fail an unavailable pool job without starting a process provider.

Prefer `lcm import --replay --replay-provider session-pool` or
`lcm compact --replay --replay-provider session-pool` to select the pool for replay
alone. These commands leave the configured live compaction provider unchanged.
`llm.provider: "session-pool"` and `LCM_SUMMARY_PROVIDER=session-pool` select it
for every compaction explicitly. `--parallel N` on either replay command runs at
most N projects concurrently (default 1); each project's session order, previous
summary, manifest and ledger retain their existing behavior.

| Worker setting | Meaning |
|---|---|
| `LCM_SUMMARIZE_WORKER=1` | Opt the launched Claude Code or OMP session into pool serving. |
| `LCM_SUMMARIZE_WORKER_MODEL` | `haiku` (default) or `sonnet`. Claude resolves the alias through its allowlist; OMP selects the newest matching Anthropic model id in its registry. |
| `LCM_SUMMARIZE_WORKER_MAX_OUTPUT_TOKENS` | Per-worker output cap. Defaults to Claude's plugin `sessionSummarizerMaxOutputTokens`, or 50000 for OMP. A non-negative integer; 0 disables serving. |

Claude workers require function hooks. They use `$.model.complete` for both leaf
and condensed jobs, never `fork`. OMP workers use the host's `pi-ai.complete` and
`modelRegistry` credentials. They send no messages to the worker's conversation.
Hook usage is recorded as `session-pool:haiku` or `session-pool:sonnet`; agent submissions use a validated `session-pool:<model>`, with missing usage estimated. Requests are
limited to the remaining cap; accounted usage from failed answers also reduces
it, and reaching the cap stops polling. Cap state lasts for the module's loaded
lifetime; a fresh worker starts a new allowance.

See [Run replay with summarize workers](summarize-workers.md) for launch commands,
fallback setup, transcript hygiene evidence and host limitations.

### Request body

A model that reasons by default can spend the whole output budget thinking. Each vendor turns that off with a request field of its own, so an `openai` or `anthropic` endpoint's `body` holds extra top-level fields sent with every request:

| Endpoint | `body` |
|---|---|
| DeepSeek API | `{ "thinking": { "type": "disabled" } }` |
| OpenRouter | `{ "reasoning": { "effort": "minimal" } }` or `{ "reasoning": { "enabled": false } }`, depending on the model |
| Qwen behind an OpenAI-compatible server (llama.cpp, MLX, vLLM) | `{ "chat_template_kwargs": { "enable_thinking": false } }` |
| Qwen behind mlx-vlm's server, which ignores `chat_template_kwargs` | `{ "enable_thinking": false }` |

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
link. With none left, an output-cut rejection makes compaction halve the source chunk
at message boundaries, each half through the normal escalation, at most three times
(eight pieces). If a single message, or a piece at that limit, still gets cut answers,
deterministic source truncation is
stored at level `fallback`; raw messages remain reachable through `lcm_expand`.
Condensation splits at source-summary boundaries. Rejected answer text is never stored.
Whitespace-only exhaustion and other failures still abort the pass (`compact.failed`),
leaving replay to retry the session. Every rejected call's tokens are counted as failed,
even when splitting completes the compaction.

The same request stops the same way, so before moving on, an answer cut off at the
output cap is asked for once more on the same endpoint with a changed request: the
shorter (aggressive) summary prompt and twice the output cap the first answer stopped
at. A condensed summary has no shorter prompt and gets the larger cap alone. The retry
is a call of its own, counted like any other, and happens once per endpoint per chunk:
a request that already used the shorter prompt, including the compaction's own shorter
retry of a summary that did not shrink, moves on at its first length stop. If a retry
still stops at the cap, compaction uses the bounded split recovery described in
[Three-level escalation](architecture.md#three-level-escalation). For an n-source
chunk with p links whose answers are always cut, splitting adds at most 4p(n − 1)
calls. Each cut is logged as `summarizer.cut` with provider, model, cap, reported
output tokens (null when unknown), and the fraction of repeated four-word windows
in the answer's tail. No answer or source text is logged. A high repetition fraction
suggests a generation loop; hidden reasoning can also consume the output budget.
An endpoint's `body` (or `llm.reasoning` in the flat form) can limit that reasoning.

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

### Environment-warning measurement

Run `lcm stats --warning-backtest` in a project directory to print its offline
environment-warning report instead of the all-project stats overview. Stats fits this measurement
of stored memory; doctor is for installation health. The backtest runs directly in the
CLI, without a daemon, a model call, migrations or writes to the project database.
It scans stored calls only when this flag is supplied, since a large store may take
time to order and walk. The flag cannot be combined with `--pool` or `--json`.

The report includes point-in-time matches, precision, failure coverage, unmatched
failures and excluded outcomes, plus total, average and maximum would-be bytes and
estimated tokens per matching session. With no stored calls, the measurements are
unknown. Warnings remain off; nothing is injected or denied. See
[the replay rules and cost accounting](passive-learning.md#environment-warning-backtest).

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
conversations already compacting, and considers only a session's newest
conversation: an OMP `/clear` closes the one before it, which `/compact` cannot
reach by session id.

`compaction.autoCompactSessionStartMax` (default `2`) caps how many conversations
one session start requests compaction for, oldest-first; a larger backlog drains
across successive starts instead of bursting the summarizer. Set `hooks.disableAutoCompact`
to turn the sweep off entirely. The request is fire-and-forget, so session start's
latency is unaffected regardless of how large the backlog is.

### Agent worker exclusion

`LCM_SUMMARIZE_WORKER=1` declares a dedicated worker at harness startup. Claude's SessionStart command hook and Codex hooks persist enrollment before agent transports may claim. Only a new `startup` or `clear` session id may enroll; resume, compact, continue and fork refuse. Retained history refuses enrollment without deletion. Capture exclusion is permanent for that session and its descendants. `lcm status`, `lcm doctor` and `lcm stats` report active, finished or abandoned enrollment and last activity. Forking worker sessions is unsupported; use a fresh dedicated session. OMP hook enrollment uses its native session-manager API; its shell and MCP identities remain unverified and refused.

Function hooks retry enrollment confirmation with bounded backoff for about 30 seconds
before reporting refusal. Request-supplied ancestry never installs exclusion or changes
enrollment. Copied successful claim payloads stop future capture while preserving stored
history; doctor shows the short id and cwd for review. Codex `/clear` revocation assumes
`CODEX_THREAD_ID` stays stable across a clear, which is unverified. Shell claims and
submissions read the current id on every call; Codex MCP is refused, so a stale id has
no supported transport.

`llm.poolCompletionMs` is a positive integer in milliseconds, default 180000,
maximum 2147483647. `LCM_POOL_COMPLETION_MS` overrides it when the daemon loads
configuration. It bounds time after claim for every pool transport. Jobs have a
20000 ms queue claim window; session-owned jobs have a fresh 60000 ms completion
window after claim. Pool expiry falls along the provider chain, except unclaimed
timeline jobs stop as `busy`. Late answers are discarded without changing worker
admission or permanent capture exclusion. An
abandoned worker with a valid owner, cwd and client binding becomes active on its
next poll; finished bindings and ownerless exclusions cannot regain admission.
Agent transports are described in
[summarize workers](summarize-workers.md).
