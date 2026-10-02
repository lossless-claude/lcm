# Project timeline

The timeline is a regenerable projection of episodic and promoted memory in one
project store. Refs #711. Session sources remain authoritative.

## Model and interface

One synthetic conversation has reserved session id `lcm:project-timeline` and
`is_timeline = 1`. Digest leaves link to raw messages; period nodes link to session
frontier summaries and generated digests using the existing summary DAG. Nodes
retain exact coverage, memory revisions, generator, stale reason/time and replaced
ids. Replacements are new rows: historical content and manifests remain readable
by id. The owner is excluded from capture, restore selection, promotion, rebuild,
replay selection, orphan checks and session statistics. Expansion behavior is unchanged.

`openProjectTimeline(db, { summarize, lease, now? })` exposes:

- `settle({ calls, deadline?, reconcile?: "journal" | "full" })`: refresh dirty
  sessions, update affected month plans, and generate within the call budget.
  The default and the compatibility value `journal` both select incremental work.
  Zero calls perform no generation. Physical provider attempts are outside the budget.
- `describe(summaryId)`: period, session coverage, summary ids, session-relative
  raw-message ranges and each conversation's time basis, stale reason/time, memory
  revisions, generator and replacements;
  null for an ordinary session summary.

Reports contain generated, pending, stale, dirty, calls, failures and the stop reason.
Pending includes months whose new units have not been planned yet. Source and model
failures leave durable work available for a later invocation.

## Opt-in lifecycle

Migration creates metadata tables and leaves tracking off until explicitly enabled.
Adding the event-time coverage field restarts bootstrap for already-tracked stores,
so persisted metadata is refreshed in resumable pages.
With tracking on, it restores missing tracking and detach triggers and replaces
definitions whose SQL differs from the current code, idempotently. With tracking
off, it removes timeline triggers. It also removes `timeline_journal`,
`timeline_input_cache`, `timeline_checkpoint`, the legacy `timeline_replay_complete`
trigger and the unused `drain` column. An already-current migration reads before
writing: it takes no write lock unless schema/trigger repairs, missing state or
timeline-derived promoted memories require changes. This permits read-only
migration and reads behind concurrent writers on already-current stores.

`lcm timeline enable` creates tracking and detach triggers, sets tracking and
project generation on, and enters bootstrapping in one transaction. Bootstrap
seeds at most 256 sessions per lease, yielding between pages with a persisted
cursor. Seeding marks existing sessions dirty and never resets a write counter. Writes
between trigger creation and the end of bootstrap therefore stay visible,
including a new session whose sort position is behind the cursor.

`lcm timeline disable` stops project generation and leaves tracking installed.
`lcm timeline teardown` removes the timeline's outgoing DAG and raw-message
references, removes its context and plans, retires its nodes, and then drops the
triggers in one transaction. It preserves historical node content and session
counter tombstones. With `--remove-nodes`, teardown also detaches every edge to or
from owner summaries, then deletes all owner summaries and timeline node rows in
the same transaction. Session summaries and messages remain intact. Re-enabling
seeds and rebuilds metadata without resetting counters.

## Revisions and persisted plan

`timeline_dirty(session_id, rev, dirty, reason, bumped_at)` holds monotonic write
counters outside the core tables. A session spans every conversation on either
side of an OMP clear. Counters survive conversation deletion, rename and recreation,
so deletion cannot cause an ABA. Triggers bump counters on source content,
identity and lineage changes. Context ordering and ordinary message parts do not
change projection membership; compaction-event parts do.

Before source deletion, detach triggers flag affected nodes and remove incoming
timeline references before restrictive foreign keys or cascades run. Rebuild,
replay reset and conversation deletion retain historical projections. NUL repair
explicitly marks its sessions dirty in the repair transaction.

`timeline_items` contains only ids, dates, tokens, positions and coverage metadata
for each session's frontier and raw remainder. It contains no text or hashes.
`timeline_sessions` holds the frontier fingerprint. `timeline_units` stores each
work key, level, month, metadata, status, failures and next retry time.
`timeline_months` marks the months needing a new plan. Source text is read by id
only when rendering a ready unit; it is never copied to a persisted cache.

Memory revisions cover content, tags and archived state. Attribution and confidence
changes do not invalidate a claim. Active manual memories with NULL summary
provenance, excluding signal and passive-capture tags, enter as separate attributed
claims inside the unit's coverage bounds. Prompts preserve disagreements between
claims and session evidence. Legacy NULL provenance cannot conclusively establish
manual origin; that distinction remains unconfirmed.

## Incremental settle and publication

1. Read at most 256 dirty session markers.
2. Outside the lease, read each session's frontier and uncovered messages using
   indexed queries. Ignore timeline-owner edges when finding the session frontier.
3. In one lease per session, validate its counter. If its fingerprint is unchanged,
   clear dirt at that revision. Covered-message NUL repair therefore regenerates
   nothing. Otherwise replace that session's metadata, flag dependent nodes through
   the session index, and mark its old and new months. A counter conflict leaves
   that session dirty for the next settle; other sessions continue in this pass.
4. Replan marked months from metadata only. Existing summaries are indivisible;
   chunking ignores summary depth and closes at the configured leaf token limit
   or a UTC month boundary, assigned by latest coverage date. Raw dates use
   `messages.event_at` when known and capture `created_at` otherwise; summary
   bounds use the same per-message fallback. Source `timeBasis` is `event`,
   `capture` or `mixed`, persisted in coverage and exposed by describe and search.
   Generation sources explicitly label capture-time fallback. The latest replay
   manifest supplies session order; otherwise order by date, session, conversation,
   sequence and id. Actual coverage bounds are preserved for spanning summaries.
5. Hydrate one ready unit by source id and call the summarizer outside the lease.
   Skip units whose sessions conflicted and continue with independent ready units.
6. Publish in exactly one lease and one synchronous transaction. Validate only
   that unit's session counters, memory hashes, work key and generator. A write
   to another session does not reject the result. Digest publication marks its
   month for the next planning pass; period publication marks nothing. Publication
   does no source refresh or replan. A publication conflict also leaves its changed
   sessions dirty and allows independent units to proceed. Report `conflict` only
   when no unaffected session could be applied and no unit was generated.

Periods whose boundaries depend on a pending digest's output size wait for that
digest. Ready periods in independent months can proceed. A later session summary
retires obsolete raw digests; replacement periods retire overlapping stale periods
and record their ids. Historical rows remain immutable and addressable.

## Scheduling and explicit healing

`timeline.generationEnabled` gates model generation and defaults to false.
Tracking and project generation must also be enabled for automatic work. The daemon
checks every 30 seconds and resumes one bootstrap page of at most 256 sessions per
tick, yielding without model calls. Generation starts after bootstrap, waits for
60 seconds without a newer session bump, and runs at most one unit per project per
tick. Durable units resume across restarts.

Every admitted provider and fallback must be `session-pool` or a named OpenAI or
Anthropic HTTP endpoint with `maxConcurrent`. Shared endpoint and pool admission
place live work first, replay/background second and timeline last, FIFO within each
class. The existing `llm.provider` chain selects the timeline provider. Flat pool
configuration requires `llm.fallbackProvider: "disabled"`; named pool chains may
fall back only to bounded HTTP endpoints. Pool jobs use `lcm:project-timeline` as
their session binding and do not extend live or replay deadlines.
Process, live-session and unbounded HTTP adapters cannot serve timeline work. Scripted test summarizers
substitute for provider admission. Endpoints with missing environment variables
are skipped, and admission requires at least one runnable endpoint.
The `/timeline` route checks admission before database work for generation requests.
A refusal returns HTTP 409 with configuration guidance, printed verbatim by the CLI.
It does not call the summarizer, flag `generate-failed`, back off or park a unit.
Zero-call reconciliation remains available without an admitted provider.
The first admitted generation settle releases legacy failures once, including
configuration-induced backoff and parking. Legacy units lack failure causes,
so legacy model failures also receive one retry. A persisted `admission_recovered`
marker prevents later settles from bypassing model-error or conflict backoff.

Model errors and publication conflicts persist exponential backoff, beginning at
one minute and capped at one hour. Eight failures park a unit until one of its sessions changes.
Only the latest replay manifest can hold work; an unfinished run's hold expires
five minutes after its last ledger progress (or manifest creation). Ordinary ticks
drain persisted work once generation is on and replay no longer holds it; ledger
inserts execute no timeline completion trigger or manifest scan. Timeline failures
cannot undo committed replay progress.

`lcm status` and `lcm doctor` are read-only: they report pending, stale and dirty
sessions, including dirt not yet reflected in node flags. They never migrate,
repair triggers, reconcile or settle. Ordinary status counts work on unmigrated
read-only stores. Failed counts print `unavailable`, and ordinary counts use
SQLite table counts minus indexed owner counts. Conservative full reconciliation requires an
explicit `lcm timeline settle --calls 0 --reconcile full`. Doctor also compares
tracking and detach definitions in `sqlite_master` read-only, reports missing or
outdated triggers and names that repair command. Normal migrations repair those
definitions whenever tracking is on.

Full reconciliation repairs tracking triggers, re-seeds sessions, and walks
conversation aggregates with a resumable cursor in pages of at most 256. No lease
spans more than a page. It re-dirties mismatches, including retained metadata for
removed conversations. Its aggregate proof deliberately misses equal-length
in-place edits and edge substitutions that keep counts; NUL repair's explicit
marker covers that supported repair path.

## Deferred decisions and evidence

Dirt is session-scoped in v1; exact row locators are deferred. Astra's objection
is that a session marker loses the edit's location: one change in a large
unsummarized remainder rereads that entire remainder. Compaction normally bounds
remainders, which makes session dirt an acceptable first-version trade-off.

Chunks may repack within one month in v1; stable persisted boundaries and local
splits are deferred. Astra's objection is that an early edit can shift boundaries
and force regeneration of later units. A month bounds that propagation; existing
summaries stay indivisible.

Confirmed in code: `src/db/project-timeline.ts:enableTimeline` owns atomic trigger
installation; `installProjectTimeline` keeps tracked definitions current;
`src/doctor/timeline-check.ts:checkProjectTimeline` checks installed definitions
read-only; `src/daemon/routes/timeline.ts:createTimelineHandler` refuses unadmitted
generation before database work; `Timeline.refreshSessions` validates counters
and skips conflicted sessions; `Timeline.planMonth`
reads persisted metadata; `Timeline.publish` validates local source revisions;
`src/daemon/project-timeline.ts:timelineTick` owns debounce and replay admission.
Tests use isolated SQLite, scripted summaries and fake clocks. Initialized row-count
acceptance compares the same fifty dirty sessions on two store sizes, cold bootstrap
is tested separately as linear, query plans use `messages(conversation_id, seq)`
and do not scan `summary_messages`, and tracking-off inserts have no timeline triggers.

Real-corpus recall quality, citation accuracy and model cost remain unconfirmed.
Additional time levels, cross-store synthesis, restore prefixing, memory
anchors/corrections (#712) and session-to-commit references (#713) are deferred.
Before downgrading, `lcm timeline teardown --remove-nodes` removes all owner
summaries and timeline node rows while keeping session sources. Without removal,
a downgraded lcm promotes timeline nodes at every session end, including after
ordinary teardown. Re-upgrading archives promoted memories whose
`source_summary_id` names an owner summary or whose `session_id` is
`lcm:project-timeline`. Such rows are never legitimate promoted memories;
archival leaves their content and provenance available for inspection.
