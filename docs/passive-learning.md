# Passive Learning

Passive learning captures your Claude Code sessions automatically; durable insights are still stored explicitly with `lcm_store`. It observes tool usage patterns, user decisions, and session events, then promotes high-signal observations into cross-session memory.

## How It Works

### Event Capture

Two hooks capture events during your session:

- **PostToolUse** / **PostToolUseFailure** — fire after every tool call, success or failure. Extract structured metadata (tool name, command, file path) from tool inputs. The sidecar does not capture raw tool input and output, with one deliberate exception: `AskUserQuestion` stores the truncated question and the answer you chose, because the answer *is* the decision the event records.
- **UserPromptSubmit** — fires on each user prompt. Detects role statements ("I'm a data scientist") and intent patterns. Intent events are session metadata and are never promoted, even when repeated or matching an existing memory. It does not detect decisions: a keyword match is not a lasting decision (see [decision-detection-eval.md](design/decision-detection-eval.md)).

Both Claude Code and Codex CLI drive the same tool-event extractor. Codex maps native `apply_patch` inputs and accepts `exec_command` as a compatibility spelling for unified command execution; unknown names remain untouched. Every event records `client` (`claude` or `codex`, the harness that produced it — `claude` by default) and `model` (the model that issued the tool call). When a hook does not carry the model, the next transcript ingest fills it without overwriting an existing value: Claude joins tool-call IDs, and Codex joins `turn_id` values against the transcript's `turn_context` records.

Events are written to a **sidecar SQLite database** (`~/.lossless-claude/events/<project-hash>.db`) at <10ms cost. This is separate from the main LCM database — if the daemon is unavailable, events are safely queued.

### What Gets Captured

| Category | Examples | Priority |
|----------|----------|----------|
| Decisions | User answers to AskUserQuestion | 1 (immediate) |
| Plan approvals | EnterPlanMode / ExitPlanMode events | 1 (immediate) |
| Errors | Bash commands that fail (isError: true) | 1 (immediate) |
| Git operations | Commits, merges, branch switches | 2 (batch) |
| Environment | `npm install`, `pip install`, `brew install` | 2 (batch) |
| File access | Read/Edit/Write/Glob/Grep with file paths | 3 (pattern-only) |
| MCP tools | Which MCP tools are used (tool name only) | 3 (pattern-only) |
| Skills | Which skills are invoked | 3 (pattern-only) |
| Subagents | Which subagent was dispatched, with its task description | 3 (pattern-only) |

### What Is NOT Captured

- Raw tool payload contents such as file contents and command stdout/stderr (only tool metadata and brief user answers are stored)
- Sensitive file paths (`.env`, `.ssh/`, `credentials`, `.npmrc`)
- LCM's own `lcm_store` calls (prevents feedback loops)

### Three-Tier Promotion

Events are promoted to cross-session memory at session boundaries (session-end, pre-compact, or next session start):

**Tier 1 — Immediate promotion** (priority 1): Decisions, plan approvals, and error observations are promoted directly with confidence scores. Immediate per-tool promotion does not refresh tool lessons.

**Tier 2 — Batch promotion** (priority 2): Git and environment events are promoted with moderate confidence (0.3).

**Tier 3 — Pattern reinforcement** (priority 3): File access and tool usage events start as low-confidence signals. A one-off event is skipped unless it matches an existing entry in the promoted store. To bootstrap a new promotion without a seed, the same pattern must appear at least three times across at least two distinct sessions in recent sidecar history. That reinforcement boost only applies on the insert path for a new memory, not when re-confirming an already-promoted entry.

### Promotion tags

Every passive promotion carries a `type:` tag. The event category maps to the type below;
unknown categories use `type:pattern`. No `category:` tag is written: event categories
remain in the sidecar database, and promoted-memory filters select on `type:`.

| Event category | Promoted tag |
|----------------|--------------|
| `decision` (user answer) | `type:preference` |
| `plan` | `type:decision` |
| `error` | `type:gotcha` |
| `role`, `context` | `type:user-context` |
| `env` | `type:environment` |
| `git`, `task`, `security` | `type:workflow` |
| `intent` | Not promoted |
| `file`, `mcp`, `skill`, `subagent`, unknown | `type:pattern` |

### Deterministic Tool Lessons

Tool lessons come from stored shell calls in `transcript_tool_calls`, independently
of sidecar event text. They are scoped to the project, use no model calls, and carry
occurrence counts, counts per session, and first and last seen dates instead of
confidence scores. Dates use the call message's transcript time, falling back to
its capture time. Declared summarize-worker sessions are excluded.

- **Command shape**: the executable's basename and a recognized subcommand, followed
  by sorted, unique flags. Positional paths and values, including attached flag
  values, collapse to `<args>`. For example, `git diff --stat src/a.ts` becomes
  `git diff --stat <args>`. A short token longer than one flag letter retains
  only its first letter and a value placeholder: `mysql -psecret -uadmin` becomes
  `mysql -p -u <args>`. The exception is a known value-free cluster: for `rm`,
  combinations of `d f i P R r v W` retain their letters, such as `-rf`.
  The same token on another executable receives a placeholder; no attached
  value text is retained. Common command families such as git, npm, pip, cargo,
  docker and gh retain their first subcommand. Other executables retain their
  executable and flags. Quoted arguments are values, including quoted subcommands;
  stored argument arrays are supported. Leading `NAME=value` assignments are
  dropped, as is a leading `cd <dir>` joined with `&&` or `;`. Directory and
  assignment values never enter the shape. `sh`, `bash` and `zsh` wrappers using
  `-c`, `-lc` or `-cl`, including stored argument arrays, use their inner command's
  shape. Chains and pipelines join complete segment shapes with `&&`, `||`, `;`
  or `|`; a wrapper's inner chain retains its grouping within an outer chain.
  For example, `cd /tmp/project && npm run build && npm test` becomes
  `npm run <args> && npm test`. If any segment cannot establish a shape, the
  entire command has none. Unbalanced quotes, incomplete wrappers, substitutions,
  redirections, shell comments and truncated inputs do not establish a shape. Wrapper nesting
  is limited to eight levels; deeper nesting has no shape. Parsing and flag
  ordering take linear work in the capped command length.
- **Error→fix pair**: a `failed` or `blocked` shell call followed by the first
  `succeeded` call of the same shape in the same session, within the next
  20 stored calls. All calls count toward the window, including non-shell and
  `unknown` calls. A pair keeps both scrubbed commands. Matching a shape records
  an observed failure→success sequence; it does not establish that the command's
  changed values caused the success. This replaces the token-prefix correlator.
- **Block reason**: the blocked result's first line, with paths, filenames and
  identifiers masked, counted across the project and separately for each session.
  Capture retains this line, scrubbed and capped at 2048 UTF-8 bytes, beside the call
  as `block_reason`. Older calls without that evidence contribute no block reason
  until transcript capture or backfill records it.
- **Environment rule**: a shape that was `failed` or `blocked` in at least three
  distinct sessions, with no `succeeded` call since its earliest failure.
  A later success retires the rule across the project, even in a different session.
  A success before the first failure does not retire it. Transcript time orders
  that evidence, with stored message and call order breaking ties.

A chain's outcome is evidence only for its complete shape. Neither failure nor
success identifies an individual segment's outcome, so it cannot establish a
segment's rule, retire that rule or pair with a segment's success.

`unknown`, `denied` and `interrupted` calls establish neither failure nor success
for these lessons. In particular, an ordinary non-error sidecar event is not
evidence of a successful command.

Lessons live in `tool_lessons` in the main project database, separate from promoted
memory. `/promote-events` refreshes them at capture/promotion boundaries, including
when no sidecar events are pending, and skips the refresh when no stored call was
changed since the published snapshot. A transactional change journal records
added and resolved calls, input or block-reason corrections, and message-time
repairs. Refresh reads those calls and their bounded 20-call pairing windows,
updates their persisted contributions and counts, and publishes only affected
lesson keys. A removed call invalidates and re-derives its session, including
pairs whose window shortened; other sessions are retained. Worker exclusion
also invalidates the affected session. Indexed evidence supplies first and last
dates and environment-rule retirement without a project scan.
The first refresh after upgrading an older snapshot re-derives existing calls once.
The prefix, wrapper and chain shape upgrade also queues every stored call once on
stores that already have incremental tables. The queue and its completion marker
commit together; refresh replaces old-format keys through the same contribution
journal and publication path. Reopening the store does not queue them again.
Refresh processes pages of at most 128 changed calls or lessons. Each page collects
changed calls and their 20-call predecessors, evaluates each distinct affected
pair once, and caches shapes (including absent shapes) for that page's calls and
windows only. Pages follow session and call position; the last processed position
avoids repeating predecessor pairs across pages. Journal entries remain until
their contributions and all affected pairs are durable.
`REFRESH_TIME_BUDGET_MS` is a 10 ms event-loop budget shared by call updates, pair
updates, session invalidation and publication. Refresh checks it after synchronous
units and yields before starting another once it is spent, as well as between
pages. A single unit can overrun the budget. Each write unit finishes its savepoint
before yielding; no transaction stays open across a yield.
The project mutation lease serializes refreshes;
ordinary refresh work depends on changed evidence and its pairing windows,
while deletion depends on the affected session. Readers see the previous complete
snapshot until a single generation switch publishes updated lesson versions.
Persisted journal and publication state allow an interrupted refresh to resume.
Immediate per-tool callers set `skip_tool_lessons: true`; they do no project lesson
scan. Restore reads at most three active environment rules from the published
snapshot and never derives them on the SessionStart path.

Lesson tags are `type:solution` for pairs, `type:gotcha` for block reasons, and
`type:environment` for environment rules, together with `source:tool-calls` and
`project:<project-id>`. Retired rules stay in the snapshot for inspection and
are excluded from learned insights. The promotion response's `correlated` count
reports the pairs in the refreshed snapshot; `promoted` still counts sidecar
events written to promoted memory.

### Learned Insights

On SessionStart, up to three recent active environment rules and promoted passive
insights are surfaced in a `<learned-insights>` block, capped at five combined
entries, with rules first. A rule is one line naming the command shape (cut at 120
characters), its session count and last date; it never carries a command. Error→fix
pairs and block reasons carry whole commands, so they stay in the snapshot and are
not shown until shadow measurement shows that showing them prevents repeats.
Promoted event memories retain their confidence scores. Both use the configured age limit.
Identical content appears once, retaining the first insight's metadata and order.

### Environment-warning backtest

Run `lcm stats --warning-backtest` from the project directory to measure hypothetical
warnings against its stored calls. Stats reports memory measurements; doctor checks
installation health. The backtest runs in the CLI, opens the current project's database
read-only without migrations, and uses neither a daemon nor a model. It is opt-in because
ordering and walking a large store can be slow. Ordinary stats does not run it.

The replay joins `transcript_tool_calls` to their messages, excludes declared worker
sessions, and uses the lessons' shell-tool recognition, command shapes and session
threshold. Calls are ordered by transcript time (capture time when absent), then message
id, then call rowid. A rule matches only when at least three distinct sessions failed or
were blocked on that shape strictly before the call. A success after the first failure
permanently retires it, even before activation. The retiring success itself can match;
the replay evaluates a call before adding its evidence.

The report shows:

- **Matches:** shaped shell calls with an active rule at that position.
- **Precision:** matched `failed` or `blocked` calls divided by matched `failed`,
  `blocked` or `succeeded` calls. Matched `unknown`, `denied` and `interrupted` outcomes
  are excluded from precision, with a separate count for each.
- **Coverage:** matched `failed` or `blocked` shaped shell calls divided by all
  `failed` or `blocked` shaped shell calls. It also counts failing calls without a match
  and shell failures without a usable shape; the latter are outside coverage.
- **Would-be context cost:** the SessionStart environment-rule line, with only the
  session count and last failure date known before that call, measured in UTF-8 bytes
  and the existing character-based token estimate. All matches, including excluded
  precision outcomes, contribute cost. Totals, average per session with at least one
  match, and the maximum for one session are reported. No-match sessions are outside
  the average. An empty denominator is unknown; no stored calls yields a no-data report.

The walk visits each call once in pages of at most 128 rows from one ordered SQLite
cursor. Its application memory grows with distinct shapes, not calls or sessions.
Distinct-session evidence and per-session costs use a private temporary disk database
with a bounded cache, removed when closed. SQLite may sort the source calls on disk;
the ordered walk itself is O(calls). No hook, lookup log or lesson snapshot is written.
Nothing is injected or denied: pre-tool warnings stay off. Enabling them and choosing
their execution path is a separate decision based on this report.

## Configuration

Event promotion thresholds and the insight age limit are configurable in `~/.lossless-claude/config.json` under `compaction.promotionThresholds`:

```json
{
  "compaction": {
    "promotionThresholds": {
      "eventConfidence": {
        "decision": 0.5,
        "plan": 0.7,
        "batch": 0.3,
        "pattern": 0.2
      },
      "reinforcementBoost": 0.3,
      "maxConfidence": 1.0,
      "insightsMaxAgeDays": 90
    }
  }
}
```

The legacy `eventConfidence.errorFix` field remains accepted for compatibility; tool lessons do not use it. Their 20-call window and three-session environment threshold are fixed.

When a pattern crosses the reinforcement threshold, `reinforcementBoost` is added to the base pattern confidence, capped by `maxConfidence`, only when bootstrapping a new promoted entry.

## Data Storage

- **Sidecar DB**: `~/.lossless-claude/events/<sha256-of-project-path>.db`
  - Per-project SQLite database in WAL mode
  - Processed events pruned after 7 days
  - Unprocessed events capped at 10,000 rows (oldest pruned first)
  - Schema versioned for future migrations (`SCHEMA_VERSION` in `src/hooks/events-db.ts`)

- **Tool lesson snapshots**: `tool_lessons` and `tool_lesson_state` in the main project database
  - Derived from scrubbed stored calls; no model or confidence scoring
  - Published by generation; active environment rules are surfaced during restore
  - Internal change journals, per-call contributions, counts and success evidence
    support incremental refresh; unchanged lesson versions remain published
  - These are derived observations, outside promoted-memory search and deduplication

- **Error log**: `error_log` table in each sidecar DB
  - Records hook errors with timestamp and session ID
  - Pruned after 30 days on SessionStart
  - Queryable by `lcm doctor` for health diagnostics

- **Promoted store**: Events promoted via `deduplicateAndInsert()` into the main LCM database
  - Tagged with `source:passive-capture` and `hook:<PostToolUse|UserPromptSubmit>`
  - Searchable via `lcm search` and `lcm grep`
  - Deduplicated via BM25 matching on the entry's first 32 terms (see `docs/search.md`)

Existing promoted memories are normalized once when their project database opens: a JSON
string containing an array is decoded into that array, and a single string tag becomes a
one-element array. Passive-capture rows gain the mapped type when they have none, and their
legacy `category:` tags are removed. Existing types (including `type:solution`) and other
metadata are preserved. Archived rows stay archived; active search-index tags are updated
with the row. Unparseable tags are preserved rather than discarded. Promoted-memory insert
and update writers reject tags that are not arrays of strings.

A separate one-time repair on project database open removes passive-capture memories whose
content is exactly `implement`, `investigate`, `review` or `refactor`, together with their
search-index entries. Manual memories are preserved, including matching text. The repair
and its completion marker commit together; subsequent opens do not repeat it.

## Recovery

| Scenario | Behavior |
|----------|----------|
| Clean session end | Events promoted via `/promote-events` |
| Ctrl+C (SIGINT) | Stop hook triggers best-effort promotion |
| Pre-compact | Events promoted before context is compacted |
| Daemon unavailable | Events queued in sidecar, promoted next session |
| Hard kill (SIGKILL) | Events survive in sidecar, scavenged on next SessionStart |
| Unprocessed cap exceeded | Oldest events pruned when > 10,000 rows or > 30 days |
| Error log pruning | Entries older than 30 days removed on SessionStart |

## Observability

### `lcm doctor`

When passive learning hooks are installed, `lcm doctor` includes a "Passive Learning" category with three checks:

| Check | What it monitors |
|-------|-----------------|
| `events-capture` | Total events captured, unprocessed count |
| `events-errors` | Hook error count (last 30 days) |
| `events-staleness` | Time since last event capture |

Run `lcm doctor` to see the per-project breakdown and recent error details.

### `lcm stats`

A single line is added to the Memory section when events have been captured:

```
Events          1,234 captured (42 unprocessed, 3 errors (30d))
```

### Error Handling

All hooks use a three-layer error fence (`safeLogError`):

1. **Layer 1**: Write to sidecar DB `error_log` table (queryable by doctor/stats)
2. **Layer 2**: Append to `~/.lossless-claude/logs/events.log` (flat file fallback)
3. **Layer 3**: Swallow silently — hooks must never crash or interfere with Claude Code
