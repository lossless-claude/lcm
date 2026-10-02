# Architecture

This document describes how lcm works internally — the data model, compaction lifecycle, context assembly, and expansion system.

## Data model

### Conversations and messages

Every Claude Code session maps to a **conversation**. The first time a session ingests a message, LCM creates a conversation record keyed by the runtime session ID.

An OMP `/clear` keeps the session id and session file and appends a `reset_boundary` entry. Capture gives each side of it its own conversation under the same session id: the conversation a clear opens records the entry in `opened_by_entry_id` (NULL for a session's first), and the session's newest conversation — the one `getConversationBySessionId` returns and restore reads — holds only what followed the latest clear. A clear with nothing after it still opens its conversation, so restore never falls back to the cleared turns. Conversations stored before clears were honoured are not split. See `docs/design/omp-clear-boundary.md`.

Messages are stored with:
- **seq** — Monotonically increasing sequence number within the conversation
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction of the message; NUL characters become U+FFFD before storage so SQLite reads preserve the text after them
- **tokenCount** — Estimated token count (~4 chars/token)
- **createdAt** — Capture/insertion timestamp, independent of when the message happened
- **eventAt** — Nullable transcript record timestamp (`messages.event_at`), normalized to UTC; missing or invalid timestamps stay unknown

Conversation `firstAt` / `lastAt` are the bounds of their transcript messages,
using event time where known and capture time otherwise. Internal compaction event
rows are excluded. Conversation `createdAt` / `updatedAt` retain their storage
lifecycle meaning; an empty conversation falls back to its creation time.

Each message also has **message_parts** — structured content blocks that preserve the original shape. The part types are `text`, `reasoning`, `tool`, `patch`, `file`, `subtask`, `compaction`, `step_start`, `step_finish`, `snapshot`, `agent`, `retry`, `skill` (a skill expansion) and `command` (a slash command invocation); see `MessagePartType` in `src/store/conversation-store.ts`. This allows the assembler to reconstruct rich content when building model context, not just flat text.

`lcm import --backfill-event-times` repairs discovered sessions without capturing
new messages or making model calls. It compares session-relative positions,
excluding compaction event rows and spanning clear boundaries, with the cursor's
role/content checks under current redaction and NUL rules. OMP rewinds prefer a
stored live-path prefix, otherwise only unique in-order file matches establish
abandoned-branch positions. Repeated matches remain unknown. It stops at the first
unaligned position, fills only unknown timestamps in transactions of at most 256
messages, and yields between pages. Missing transcripts leave times unknown.
Rerunning resumes through NULL rows; leaf and condensed summary bounds are
recomputed in depth order in pages of at most 128 summaries, including on an
idempotent retry after an interrupted repair. Existing summary text is retained.

### The summary DAG

Summaries form a directed acyclic graph with two node types:

**Leaf summaries** (depth 0, kind `"leaf"`):
- Created from a chunk of raw messages
- Linked to source messages via `summary_messages`
- Contain a narrative summary with timestamps
- Typically 800–1200 tokens

**Condensed summaries** (depth 1+, kind `"condensed"`):
- Created from a chunk of summaries at the same depth
- Linked to parent summaries via `summary_parents`
- Each depth tier uses a progressively more abstract prompt
- Typically 1500–2000 tokens

Every summary carries:
- **summaryId** — `sum_` + 16 hex chars (SHA-256 of content + timestamp)
- **conversationId** — Which conversation it belongs to
- **depth** — Position in the hierarchy (0 = leaf)
- **earliestAt / latestAt** — Source event-time bounds, falling back per message to capture time; condensed summaries inherit their source summaries' bounds
- **descendantCount** — Total number of ancestor summaries (transitive)
- **fileIds** — References to large files mentioned in the source
- **tokenCount** — Estimated tokens

### Project timeline storage

The timeline is a regenerable projection in the same SQLite store. Ordinary
summary rows belong to the reserved `lcm:project-timeline` conversation, marked
`is_timeline = 1`. Side tables retain exact coverage, revisions, stale state and
replacement lineage. The owner is excluded from session readers, capture,
restore selection, promotion, rebuild, replay and manual attribution. Timeline
edges do not count as consumers when checking session summaries for orphans.

Migration installs no timeline triggers while tracking is off; while tracking is
on it restores missing triggers and replaces outdated SQL. `lcm timeline enable`
atomically creates tracking and detach triggers and starts paged bootstrap. Monotonic session counters
survive deletion and recreation; bootstrap never resets them. Disable stops
project generation while retaining tracking. Teardown removes dependent references
before dropping triggers, preserving historical node content by default.
`lcm timeline teardown --remove-nodes` also deletes all owner summaries and node
rows after detaching their edges, keeping session summaries and messages intact.
A downgraded lcm promotes retained timeline nodes at every session end. Re-upgrade
migration archives promoted memories whose `source_summary_id` names an owner
summary or whose `session_id` is `lcm:project-timeline`; such rows are never
legitimate promoted memory. An already-current migration takes no write lock
unless it finds schema/trigger repairs, missing state or memories to archive.

`openProjectTimeline` exposes budgeted `settle` and model-free `describe`.
Incremental settle reads dirty sessions through indexed frontier/remainder queries,
then updates only those sessions' persisted metadata and affected UTC months.
Raw message dates use event time when known; summaries carry the same derived
bounds. Timeline coverage records `timeBasis` as `event`, `capture` or `mixed`;
describe and timeline search expose it, and generation sources label unknown-event
fallbacks. A schema upgrade refreshes older item metadata through paged bootstrap.
Counter conflicts leave the affected sessions dirty for the next pass while other
sessions and independent units continue; conflict is reported only without progress.
Items contain no text or hashes; ready units read text by id. Existing summaries
are indivisible, chunking ignores depth, and digest output gates dependent periods.
Manual memories enter as separate attributed claims; revisions cover content,
tags and archived state. Attribution and confidence changes do not invalidate them.

Generation releases the mutation lease. Publication takes one lease, validates
only the unit's session counters and memory hashes, and synchronously commits a
new immutable node and its references. Digest publication marks its month;
period publication marks nothing. Publication never replans. Obsolete raw digests
and replaced periods leave active context while retaining historical manifests.

`timeline.generationEnabled` defaults to false. Automatic work also requires
tracking and completed bootstrap, waits for 60 seconds of quiet and runs one unit
per project per tick. Model errors and publication conflicts have persisted
exponential backoff, with a one-hour cap and parking after eight failures.
Admission requires at least one runnable endpoint. The first admitted generation
settle releases legacy backed-off and parked units once: their persisted failures
have no cause, so this also retries legacy model failures. Subsequent failures
retain their backoff. Replay holds expire after
five minutes without progress; ordinary ticks drain persisted work once generation
is on and replay no longer holds it. Ledger inserts perform no timeline manifest scan.
Every provider and fallback must support shared live/background/timeline admission through a
bounded named HTTP endpoint. Unsupported providers refuse timeline generation
with a configuration 4xx before database work, without failure flags or backoff.

Status and doctor read persisted pending/stale/dirty counts, including sessions
not yet flagged, without migration, reconciliation or generation.
Doctor also reports missing or outdated tracking/detach SQL from `sqlite_master`
read-only and names the repair command.
Explicit `lcm timeline settle --calls 0 --reconcile full` repairs triggers and conservatively
checks conversation aggregates in resumable pages. Equal-length edits and equal-count
edge substitutions can escape that proof; NUL repair explicitly marks its sessions.
Search hides stale nodes unless `lcm search --include-stale` is requested. Describe
adds coverage; expansion behavior is unchanged. See [the design](design/project-timeline.md)
for lifecycle, queries and the deferred session-dirt and month-repacking trade-offs.

### Context items

The **context_items** table maintains the ordered list of what the model sees for each conversation. Each entry is either a message reference or a summary reference, identified by ordinal.

When compaction creates a summary from a range of messages (or summaries), the source items are replaced by a single summary item. This keeps the context list compact while preserving ordering.

### The store surface

Episodic memory is reached through two stores, and only through them: `ConversationStore` (`src/store/conversation-store.ts`) owns `conversations`, `messages` and `message_parts`; `SummaryStore` (`src/store/summary-store.ts`) owns `summaries`, their lineage tables, `context_items` and `large_files`. Promoted memory is reached through `PromotedStore` (`src/db/promoted.ts`), which owns `promoted` and is the one reader of how a vote is encoded in its tags. No daemon route, the importer or the capture module prepares its own statement against those tables; `test/store/store-surface.test.ts` pins that, and every public store method has a caller in `src/`. Callers with their own SQL for other reasons — replay, stats, native history search, the bench — stay outside the stores.

The operations are shaped by what Episodic memory is asked to do:

- **Find the conversation of a session** — `getOrCreateConversation` opens it on first capture and fills attribution in once a sidecar names a parent; `getOrOpenConversationAt` opens the one a clear starts; `getConversationBySessionId` answers the newest afterwards; `latestActiveConversation` is what a session that captured nothing yet is shown instead.
- **Append a delta** — `createMessagesBulk` writes the messages past the stored count, `appendContextMessages` puts them at the end of the context, `createMessageParts` keeps their structure; `getMessageCount`, `getMaxSeq` and `getMessages` describe what is stored so the next delta starts after it, and `getSessionMessageCount` / `getSessionMessages` describe it across every conversation of a session. The session pair is what capture compares with a transcript, so it leaves out the event rows compaction writes itself (a message with a `compaction` part), which no transcript holds.
- **Read the context window** — `getContextItems` for compaction's view of the whole list, `readContextWindow` for a restore's view of its end (the last N summaries and the last N user/assistant messages, with a plain-messages fallback for a conversation captured before context items were materialised), `getContextTokenCount` and `getDistinctDepthsInContext` for the compaction triggers.
- **Replace a range with a summary** — `insertSummary`, `linkSummaryToMessages` / `linkSummaryToParents` for its lineage, then `replaceContextRangeWithSummary`; `resetConversationContext` undoes every summary of a conversation and rebuilds the context from its messages. `SessionCapture.rebuildTranscript` goes further for a Claude Code session: in one transaction it deletes the conversation's summaries, context items, messages and their full-text rows and the session's replay-ledger rows (`src/claude-rebuild.ts`), then captures the transcript from its first message into the same conversation row.
- **Read summaries** — by id, by conversation, deepest-first for a session's restore, newest-first across the project, or as a subtree under `lcm_expand`.
- **Search** — `searchMessagesSync` / `searchSummariesSync`, full-text with a LIKE fallback, or regex.

### Summary promotion provenance

`POST /promote` records the originating summary's id in `source_summary_id` for
both a new promoted memory and an incoming memory archived by deduplication.
Deduplication preserves the canonical memory's existing provenance, including
NULL; the archived incoming row retains the new summary's provenance. Memories
stored explicitly or promoted from events keep NULL.

Re-promotion checks summary ids across all promoted rows, including archived
rows, without a row limit. Changing a summary's content prefix does not make it
eligible again. For active memories with NULL provenance, promotion also skips
summaries matching the first 100 characters of the memory's content, preserving
the legacy guard against re-promotion and confidence decay. This prefix rule
does not apply to memories with recorded provenance, so shared content prefixes
on those rows do not suppress different summaries. Existing rows with NULL
provenance are not backfilled.

### Manual memory session attribution

`lcm doctor --repair-manual-attribution` (`src/doctor/manual-attribution.ts`)
reads active `manual` memories through `PromotedStore` and matches normalized
content against raw Claude and Codex store-call `text`/`content` arguments.
It scans across transcript projects, but a match counts for a store only when that
store captured the matching session; ordinary stored message mentions do not
establish attribution. One such session permits attribution, several are
ambiguous, a match only in sessions other stores captured is left as "matched
outside this store", and none anywhere is unmatched. A store that fails is reported
as skipped without stopping the others. Preview uses read-only database
connections without migrations or project-record writes.

Explicit `--apply` uses the same offline hold and database-activity guard as store
cleanup, rechecking it before each store's writes. A consistent full database
backup, WAL data included, precedes the store's transaction.
`PromotedStore.attributeManual` updates only `session_id` on still-active manual
rows. Other fields and full-text rows are preserved. The printed
`db.sqlite.bak-manual-attribution-*` backup retains the old attribution for
reversion; see [the repair workflow](configuration.md#manual-memory-attribution-repair).

### The project record

Beside each project's database sits `meta.json`, the project record: `cwd`, the git identity (`git`), the detected author `language` and `languageDetectedAt`, and the `lastIngest`, `lastCompact` and `lastPromote` timestamps. `src/daemon/project-meta.ts` is its only reader and writer: every other module reads through `readProjectMeta` / `readProjectMetaIn` and updates by key through `updateProjectMeta` / `updateProjectMetaIn`, which merge a patch into the current record in one synchronous read-modify-write and land it through a temporary file and a rename, so a crash mid-write cannot leave a torn file. The cwd-keyed update always re-asserts `cwd`, so a record is never left without the key that enumeration (`lcm export --all`, `lcm compact --all`, the compaction sweep, stats) selects on.

One corrupt-file policy, whichever code path meets the file first: a read treats an unparsable file as absent; an update moves it aside as `meta.json.corrupt-<timestamp>` and starts again from the caller's keys. The alternatives both lose something silently — refusing to write leaves the project invisible to every enumeration until someone deletes the file by hand, and overwriting in place discards the evidence — while moving aside heals the project on its next write and keeps the bad bytes for inspection.

Project store creation records the destination cwd before opening its database.
Transcript capture (`/ingest`, `/compact`), `/session-complete`, `/store`,
worker enrollment, passive event promotion (`/promote-events`) and restore's
`withProjectDb` use `openProject`. Summary promotion (`/promote`) requires an
existing database and records its cwd before opening it on a write run; a dry
run leaves its record untouched. Portable knowledge import writes the destination
record before opening the database or processing entries, merging existing keys.
Other database readers require an existing store. Store ids derive from the
destination cwd's realpath when available; `/store`'s `metadata.projectId`
overrides row provenance, not the destination store or its recorded cwd.

### Store hygiene

`src/doctor/store-hygiene.ts` reports missing temporary or test working directories
from records with an absolute cwd in stores named by a project id. It retains the
id from the store directory: re-hashing a vanished cwd cannot recover a former
symlink's realpath. Ordinary missing checkouts
are retained because they may be temporarily unmounted. Unreadable or invalid
records are counted as not checked, with their complete list in the cleanup preview.
Doctor bounds per-store lists to 20 entries followed by the remaining count;
verbose diagnostics show the complete lists. Cleanup is a separate CLI path that defaults
to a read-only preview; explicit apply requires a stopped daemon under an active
hold and no retained live database activity marker. It rechecks eligibility before
moving complete project directories and
their event sidecars to `<lcm-home>/trash/projects/<batch>/`. The selected
`project_identity` and `project_remote` rows in `group-index.sqlite` are removed
in one transaction. A failed move or index update rolls back index changes and
attempts to restore every moved file; files remain in trash if restoration fails.
No stored data is deleted or automatically purged.

For databases without an absolute cwd in their project record, doctor counts
record-less stores and how many hold promoted rows, including archived memories
and feedback signals. Unreadable databases have an unknown promoted-memory count.
Cleanup preview reads existing databases without migrations and offers a cwd when
structured `cwd` or `project_id` fields identify one working directory, directly
or through a known project record. Conflicting evidence yields no suggestion.
These stores remain skipped by cleanup, including explicit apply: an operator
reviews the suggestion and restores the record manually; no record is written or
store relocated by the preview.

Doctor reads existing databases without migrations and skips an empty `summaries`
table with a `SELECT 1 FROM summaries LIMIT 1` query before querying orphan
relationships. Stores without project records still receive this check. It reports orphan summary
ids per store through `SummaryStore.getOrphanSummaryIds`: a summary is orphaned
when no context item references it and no other summary uses it as a source
(`summary_parents.parent_summary_id`). Both leaf and condensed summaries can be
orphaned. Normal output bounds ids per store to 20, with the remaining count;
`lcm doctor --verbose` reports every id. This check diagnoses the DAG without repairing it.

Test setup records the OS user's real lcm home before isolating `HOME`, validates
the temporary base before allocating directories, asserts the resolved test home
before writing, and retains the guard in CLI children.
Both `lcmHome` and `createLcmPaths` refuse that protected root and its descendants,
including symlinked ancestors, while the guard is active.

## Compaction lifecycle

### Ingestion

lcm is not called by a context-engine lifecycle API; the harness runs lcm's own hooks, and
every one of them is a thin shell around a daemon route. Claude Code's command hooks are
`lcm compact --hook` (PreCompact), `lcm restore` (SessionStart), `lcm session-end`,
`lcm user-prompt`, `lcm session-snapshot` (Stop) and `lcm post-tool` (PostToolUse and
PostToolUseFailure); the function-hooks module speaks the same routes through
`session.start`, `prompt.context`, `prompt.submit`, `prompt.section`, `turn.complete` and
`tool.call`. `docs/hook-protocol.md` is the contract for their payloads and deadlines.

Capture itself happens on `POST /ingest`, reached from `session-end`, the Stop snapshot, and
the periodic transcript scan (`scanForTranscripts` in `src/daemon/server.ts`, every 10
minutes) that recovers a session whose `SessionEnd` never ran. The scan skips a session
whose cwd no longer exists, including retained Codex recovery-guard retries, before
calling `/ingest`. One `scan.missing_cwd` debug entry counts skipped session candidates
per pass, without per-session warnings. The cwd is checked afresh on each pass, so a
directory that returns is eligible for capture again without changing its transcript.
The scan also skips a session
whose transcript is unchanged since its last successful ingest or a Claude 400 rejection —
the parent file's `(size, mtimeMs)` plus the same for every file
under its `subagents/` tree except `journal.jsonl` (each subagent transcript and its
`.meta.json` sidecar), since a subagent transcript grows, and its attribution is filled in
once its sidecar appears, through the parent's own `/ingest` while the parent file itself
may not change. Successful fingerprints are kept in memory and atomically written to a
small `scan-fingerprints.json` sidecar in each project directory, so a daemon restart skips
unchanged transcripts without opening every project database. The sidecar records the
project database's file identity and the lcm version: a missing, corrupt or stale sidecar (the
database was replaced, restored or recreated, or lcm was upgraded) is ignored and the scan
re-ingests, so what a new version adds on ingest reaches unchanged transcripts once; entries for
transcripts no longer present are removed.
The fingerprint is recorded only once the ingest for that pass succeeds
without reporting `incomplete`. A subagent `TranscriptSourceError` reports `incomplete` on
its first attempt, then the `(size, mtimeMs)` of that file and its `.meta.json` sidecar are
cached by subagent path in memory. On the next pass an unchanged failure is skipped, the parent ingest
can finish without `incomplete`, and its tree fingerprint is recorded. A changed subagent or
sidecar is retried. Other subagent failures and failed tool-call model backfills (which the
scan asks `/ingest` to run before replying with `backfill_before_reply`) remain retryable on
the next pass. A parent Claude 400 rejection, including a prefix-guard failure, is cached
only in memory and retried when its fingerprint changes or the daemon restarts. The scan
yields to the event loop between transcripts within a project as well as during the project
walk. The scan never marks a session complete. The SessionStart catch-up sweep is a
different thing and never reaches `/ingest`: it finds conversations a killed session left
uncompacted and asks `/compact` for them directly, with `skip_ingest: true`
(`docs/configuration.md#sessionstart-catch-up-sweep`). PreCompact can Capture inside `/compact`, before lcm summarization, with
separate outcomes for the two operations. `POST /session-end` hands the whole end-of-session sequence to the daemon —
ingest, then compact, promote and session-complete — after acknowledging with `202`, so a
host that stops waiting for the hook cannot drop the steps behind it.

Every route that lands transcript content in `messages` — `/ingest`, the subagent path inside it, and `/compact` — writes through one module, `src/capture.ts` (`SessionCapture`). It owns what "already stored" means (the delta past the message count of the session's conversations), scrubbing, the bulk insert, `context_items`, `message_parts`, redaction counts, the transcript cursors and `session_ingest_log`. `/session-complete` records a session in that log, with its completion time, when the session ends. `/ingest` and `lcm import` skip a Claude Code session so recorded (Codex and OMP always reach capture, whose read may recover a deferred tail) unless its transcript file was modified after that time: a resumed session appends to the same file under the same session id, so its new turns are captured, and completing it again moves the time forward. When the caller passes no attribution and the transcript is a subagent transcript, the module reads the `.meta.json` sidecar itself, so which route sees a session first does not change what is stored about it.

Claude conversations record `parser_shape` alongside `role_tagging`. The column is NULL for rows created before the stamp existed: their capture shape cannot be inferred from age or role tagging. Structured `/ingest` uses the `structured` stamp because its messages bypass the Claude parser. A `/compact` hook summarizes those stored messages directly; a later transcript capture still verifies them. An unknown or different stamp discards the cursor and triggers a comparison of the entire stored history with today's parse under the current redaction rules. If the stored history is a prefix, capture appends the tail and stamps every conversation in the same transaction. If it differs, capture writes nothing and reports the rebuild instructions. Verification costs one full comparison per session after a parser-shape change; later captures use the matching stamp and a validated persistent cursor. A repairable rebuild replaces damaged history and stamps it. When `parseTranscript` changes the rows or fields it emits, bump `CLAUDE_PARSER_SHAPE` and add the fixture snapshot named for the new value; the Claude cursor's fingerprint version includes that shape. Codex and OMP use versioned byte cursors and their own recovery checks instead of this stamp.

Capture replaces NUL in scrubbed message content with U+FFFD before the message and its full-text index are written. Leaf compaction reads that same stored content. A stored row written before this rule can read back cut at its first NUL; the compacted-session guard accepts that prefix only when the transcript has a NUL at the cut. Claude rebuild replaces the row with the full normalized message; Codex and OMP repair update only uniquely matched cut message rows and their full-text entries, retaining summaries and byte cursors.

`lcm doctor` reports what none of those routes captured (`claude-capture`, category `Capture`, `src/doctor/transcript-check.ts`): per project lcm tracks, and for the current directory's project, the Claude Code transcripts `lcm import` would find whose session has no stored message and is not complete by the rule above, with their count and the most recent path; the fix is `lcm import --provider claude` in that project. It lists directories, stats transcripts, reads subagent `.meta.json` sidecars and reads each project database read-only, never a transcript, so its cost follows the number of transcripts, not their size. A transcript modified in the last 15 minutes is left out, since its session may be in progress and the 10-minute scan has not had a pass at it. Since it never reads a transcript, one holding no message at all, which capture stores nothing for, stays listed. It does not compare a transcript's modification time with its stored messages', because Claude Code keeps appending lines that hold no message after the last one captured; so this check does not report a session captured in part, nor a transcript under a Claude Code project directory lcm does not track, other than the current one. Two tracked projects whose paths map to the same Claude Code project directory (the directory name replaces every non-alphanumeric character with `-`) cannot be told apart, so both are listed as not checked; so is a project whose `meta.json` cannot be read. `lcm doctor` separately reports unchanged subagent `TranscriptSourceError` failures as `claude-subagent-guards` (category `Capture`). The daemon writes their session ids, parent ids, paths and errors to a project sidecar tied to the database identity and lcm version; doctor lists only entries whose transcript and `.meta.json` fingerprint still matches. It reads file metadata but not transcript content. A changed file is retried on the next parent ingest. `lcm doctor` also lists rebuild backups per project with their count, total size and removal hint (`rebuild-backups`, category `Storage`), and warns when a project holds more than the two a rebuild keeps.

Hook operation evidence is separate from Capture: the project's events sidecar aggregates tool-capture and daemon pre-compaction outcomes by Session, harness, hook, operation, delivery or execution status, and reason. Individual failure codes are retained separately. Short-lived Claude Code command and Codex lifecycle hooks append bounded metadata to a local log without loading SQLite at startup. The Claude Code function module and OMP keep bounded local snapshots because their host adapters cannot use the sidecar write path when the daemon is unavailable; OMP forces its final shutdown snapshot. `lcm doctor -v` aggregates these sources; missing evidence never establishes that an expected hook did not run.

What a transcript holds beyond what is stored is answered by one interface, the transcript source (`src/transcript-source.ts`), with an adapter per harness; `SessionCapture` is its only caller, so a route names the client and the session and never chooses how the file is read. Each adapter owns its own delta model and validation. Claude locates the transcript (the caller's path, or Claude Code's own location for the session) and resumes from a validated byte cursor. Claude, Codex and OMP share the asynchronous JSONL byte reader (`src/jsonl-transcript-reader.ts`) and the per-conversation checkpoint table (`codex_ingest_cursors`, `src/db/transcript-cursor.ts`); cursors and the messages they account for commit together. Claude's record decoder is the same one `parseTranscript` uses, including role tagging, tool content, message parts and filtering, so its cursor counts parsed messages rather than JSONL lines. Claude preserves capture of a valid final JSON record without a newline, including on `/compact`, but never consumes an incomplete one. Growth after an unterminated record forces a full recovery read. Codex and OMP defer live trailing records until a newline and accept valid unterminated records only during import. The reader yields while scanning large files. Codex validates its session metadata and verifies the stored prefix whenever it cannot resume, except for the proven paginated subagent rewrite below. A transcript an adapter refuses is a `TranscriptSourceError`, which `/ingest` and `/compact` answer with 400.

The adapter's answer also carries model backfill for the session's tool-call events, so `/ingest` runs it after the response (before it for a caller that sets `backfill_before_reply`) without knowing which transcript format supplied it. Claude extracts tool-use ids and models while decoding the delta and stores those pairs in `claude_tool_use_models` in the capture transaction. Backfill looks up only ids on events still waiting for a model, including events recorded after their transcript bytes were captured or after a restart. It opens a separate read-only project connection because the capture connection may already be released; it never calls the full-file `extractToolUseModels` on this path. A full recovery replaces the model index, while an append adds only its new pairs.

When `/ingest` processes a session it also looks for that session's subagent transcripts under `<project>/<session_id>/subagents/`, recursively (a workflow run writes its own subagents under `subagents/workflows/wf_<id>/`); `journal.jsonl` is not a transcript and is skipped. `discoverSubagentTranscripts` in `src/subagent-attribution.ts` is the one walker of that directory, shared with `lcm import` and the migration backfill, so every path captures the same set with the same attribution. Two transcripts sharing a basename (so the same `sessionId`) at different depths dedupe to the first found, in walk order; the walker logs and drops every later duplicate instead of one call slicing a second transcript by the first one's stored count. The lookup is scoped to that one session directory, never a walk of the projects tree. Each subagent transcript is captured and ingested independently — one failing to parse is logged and skipped, never stopping its siblings or failing the parent's `200`, which then carries `incomplete: true` — and attributed to the parent session (see CONTEXT.md for the terms); a conversation row created before its `.meta.json` sidecar existed gets its attribution filled in on the next `/ingest` that finds it, once the sidecar appears.

### Leaf compaction

The **leaf pass** converts raw messages into leaf summaries:

1. Identify the oldest contiguous chunk of raw messages outside the **fresh tail** (protected recent messages).
2. Cap the chunk at `leafChunkTokens` (default 20k tokens).
3. Concatenate message content with event timestamps, falling back to capture time when event time is unknown.
4. Resolve the most recent prior summary for continuity (passed as `previous_context` so the LLM avoids repeating known information).
5. Send to the LLM with the leaf prompt.
6. Normalize provider response blocks (Anthropic/OpenAI text, output_text, and nested content/summary shapes) into plain text.
7. Reject an answer the model did not finish or that holds no text (see [Rejected answers](#rejected-answers)): the pass stops before anything is persisted.
8. If the summary is larger than the input (LLM failure), retry with the aggressive prompt. If still too large, fall back to deterministic truncation.
9. Persist the summary, link to source messages, and replace the message range in context_items.

### Condensation

The **condensed pass** merges summaries at the same depth into a higher-level summary:

1. Find the shallowest depth with enough contiguous same-depth summaries (≥ `leafMinFanout` for d0, ≥ `condensedMinFanout` for d1+).
2. Concatenate their content with time range headers.
3. Send to the LLM with the depth-appropriate prompt (d1, d2, or d3+).
4. Apply the same answer check and escalation strategy (normal → aggressive → truncation fallback).
5. Persist with depth = targetDepth + 1, link to parent summaries, replace the range in context_items.

### Compaction sweep

`CompactionEngine.compact` is the one entry point; `/compact` calls it once per session.

- Phase 1: Repeatedly runs leaf passes until no more eligible chunks
- Phase 2: Repeatedly runs condensation passes starting from the shallowest eligible depth
- Each pass checks for progress; stops if no tokens were saved

### Resumable replay runs

`lcm import --replay` and `lcm compact --replay` are resumable. At the start of
a run the ordered session list is frozen into a per-project `replay_manifest`
table under a `run_id`; every completed session compaction writes a
`replay_ledger` row `(run_id, session_id, position, content_fingerprint,
summary_id, outcome)` after its summary is persisted. `summary_id` is the
threading anchor: the most recently created summary of that conversation.

A restarted run adopts the latest manifest for its command, skips ledger rows
whose content fingerprint still matches (transcript `size` + floored `mtime`,
or message/token counts for DB-only compactions), restores the threaded
`previous_summary` chain from the last good row, and continues. A session
whose content changed is recompacted on its own; the sessions after it are
re-enqueued but keep their existing summaries, threaded against the older
version. `--restart` is the way to rebuild that chain.
`--restart` discards recorded progress and **all** summaries in the
conversations the run touched, hook-written ones included, rebuilding each
conversation's context from its messages before starting from scratch. Ledger
rows of the other replay command for those sessions are dropped too. Before
wiping a project, the CLI sends `/replay-reset` to the daemon. The route holds
each replay session's compaction guard, waiting for any summary already in
flight, then resets under the project queue and mutation lease. The guard
remains held until every touched conversation and the replay ledger are reset,
so a new compaction cannot enter between the wait and the wipe. A session that
another replay adds to the manifest while the guards are taken holds no guard,
so the route answers 409 and clears nothing; the reset can be retried. Only a refused
connection (`ECONNREFUSED`) establishes that no daemon is listening; then the
CLI resets the project database directly. Other daemon errors stop the reset
without a local write.

The chain follows what the daemon persisted, not whether the HTTP call
returned in time. When the client gives up on a `/compact` call (timeout,
abort, or a mid-flight socket drop), the daemon may have finished the
compaction anyway, so the run re-reads the session's latest persisted summary
from the project DB — accepting only summaries persisted no earlier than the
second the call started (`created_at` has whole-second precision), so a stale
one from an earlier run or hook is not mistaken for the in-flight call's
result. If a fresh summary is found, the chain continues
through it and the session is recorded as `compacted` in the ledger despite
the failed HTTP call. If nothing new was persisted, the previous chain link is
kept and the session is skipped (retried by the next run). Only a
daemon-reported failure breaks the chain at that link.

A refused connection (the daemon process itself is gone, not just slow) is
different from a client giving up: every later call would fail the same way,
so `lcm import --replay` and `lcm compact --replay` stop the run there instead
of marking every remaining session failed and breaking each one's chain link
in turn. Nothing is recorded for the session in flight when this happens — no
ledger row, no chain reset — so a plain rerun of the same command resumes
exactly where it stopped, using the manifest/ledger already on disk. `lcm
compact` also skips its post-batch auto-promote step in this case: `/promote`
has no timeout, so posting it to a daemon that just proved unreachable could
hang the command right after it reported stopping.

A mid-flight socket drop (`ECONNRESET`, `EPIPE`) is ambiguous by itself: it
looks the same whether the daemon just died or is alive but wedged — its
event loop blocked on something slow — and RSTing every request it cannot
service, `/health` included. The run resolves this with a short `/health`
probe before deciding: a healthy answer means the daemon is only slow, so the
session gets the give-up treatment above (recover its summary if one was
persisted, otherwise skip it and keep going); no answer means the daemon
cannot be trusted to service anything else either, so the run stops the same
way it does for a refused connection.

SIGINT/SIGTERM let the in-flight compaction settle before exiting, so a resumed
run never duplicates or skips a half-finished session. A second signal exits
at once.

### Three-level escalation

Every summarization attempt follows this escalation:

1. **Normal** — Standard prompt, temperature 0.2
2. **Aggressive** — Tighter prompt requesting only durable facts, temperature 0.1, lower target tokens
3. **Fallback** — Deterministic truncation to ~512 tokens, ending in a `[Truncated from N tokens]` marker (N is the input size)

The fallback keeps compaction making progress when the LLM answers but does not shrink its
input; it never stands in for a rejected answer.

### Rejected answers

An answer is not a summary when the model stopped at its output limit — an OpenAI-compatible
`finish_reason: "length"`, an Anthropic `stop_reason: "max_tokens"` — or when it holds only
whitespace. A reasoning model can spend the whole output budget thinking and return a
readable but cut-off tail, so a length stop is rejected however the text looks. The HTTP
adapters throw `SummaryRejectedError` (`src/llm/summary-rejection.ts`) after reporting the
call's usage; `CompactionEngine` applies the same whitespace check to every provider's answer,
leaf and condensed, before the escalation above. An adapter does not retry a length stop,
since the same request with the same budget stops the same way; an empty answer is retried
like a transient failure.

A length stop is retried once by the provider chain below, on the same link, with a changed
request: the aggressive prompt and twice the output cap the answer stopped at
(`SummaryRejectedError.maxOutputTokens`, sent back as `SummarizeContext.maxOutputTokens`).
The aggressive prompt lowers a leaf's target, and with it the cap derived from it, so the cap
is raised rather than derived; a condensed prompt has no aggressive form and gets the larger
cap alone. A request that was already aggressive is not retried, which bounds the retry to one
per link per chunk. The engine does not see the retry: the level it reports stays `normal`.

A rejected answer moves the provider chain below to its next link, as an error does. With no
link left, the rejection fails the pass: nothing from it is persisted and context is unchanged,
while passes that finished earlier in the same compaction stay. `/compact` answers 500 naming
the rejection and logs `compact.failed`, so a replay does not ledger the session and the next
run retries it. The rejected call's tokens are recorded in `llm_usage_stats` as a failed call.

### Provider chain

Every summarization goes through one chain of links, built by `createSummarizer`
(`src/daemon/summarizer.ts`) and run by `createProviderChain` (`src/llm/provider-chain.ts`):
`/compact`, language detection, `lcm bench` and the summarizer eval harness all get it from
that factory. A link is the live session, an HTTP endpoint (`openai`, `anthropic`) or a CLI
process. With `llm.providers` the links are `llm.provider` then `llm.fallback`, named
endpoints validated once at config load (`src/daemon/provider-config.ts`); in the flat form
they are the one configured provider, or the session followed by `llm.fallbackProvider`
(`auto` when unset). A named endpoint whose `${NAME}` was unset at load is left out of the
chain; with none left, the first summary throws `SummarizerUnavailableError` naming each
endpoint and variable, and `/health` and `lcm doctor` report the endpoints left out.

Each link is tried once per call, after its adapter's own retries, plus the chain's one retry
of a length stop (see [Rejected answers](#rejected-answers)). The next link runs
after a session that did not answer (`SessionUnavailableError`), a `SummaryRejectedError`, a
refused key (401/403), an account that cannot pay (402), a connection failure or a transient status still failing after the
retries (408, 429, 5xx), or a failed CLI run. Anything else — a 400/422, a cancelled request,
a missing client library, an unclassified exception — is thrown at once, since trying the next
link would hide it. The exception is a 400/422 answering the retry of a length stop: its larger
cap may exceed the model's output limit, so the next link runs. When more than one link ran and all failed, the chain throws
`ProviderChainExhaustedError`, naming each failure; like a rejection, it fails the pass and
never becomes the deterministic fallback above.

The chain calls `onFallback` between attempts, which is where `/compact` settles the abandoned
attempt as failed before the next one reports its usage. A link's retry of its own length stop
is an attempt of its own, so its `onFallback` (and the `summarizer.fallback` log record) names
the same link at both ends. A named endpoint's usage carries the
endpoint's name, so one pass can record a failed `deepseek` call and an ok `openrouter` call.

A link's adapter is built on first use, the first link's when the summarizer is created: a
fallback whose client library is not installed fails only when the chain reaches it. An
endpoint's `body` is merged into its request under the fields the adapter generates.

## Context assembly

There is no message-array assembler: nothing in lcm rewrites the harness's message list.
What a session starts with is one block of text, and `POST /restore` is the only thing that
builds it.

1. Read the session's recent summaries deepest-first, and the project's promoted memory.
2. Render each block as plain text and fence it. Each restored summary begins with
   `Summary [<summaryId>]:` on its own line, followed by its stored `content`. The header
   comes from the database id, independently of generated text, and can be passed to
   `lcm_describe` or `lcm_expand`. Claude Code joins these entries in one
   `<recent-session-context>` block; Codex and OMP preserve the same header in their
   context window (including the `<recent-project-context>` startup fallback). Promoted
   memories have their own fenced block, passive-capture insights beside them.
3. Fit the result to the byte budget the caller's client implies; a section that cannot be
   read contributes nothing rather than failing the call.

The harness, not lcm, decides where that text goes in the model's context.

### Session start

`POST /restore` is what a harness calls when a session starts. `src/daemon/routes/restore.ts`
is only its wire; every assembly rule lives in `src/daemon/restore/`, behind one entry point,
`createRestore(config, paths)`. The module decides which client is asking (`"codex"`,
otherwise Claude Code) and whether the restore follows a compaction — the `source` the
harness sent, or else the mark `/compact` left for that session — and therefore which blocks
are read. Claude Code replays the saved CLAUDE.md snapshot after a compaction and otherwise
returns the session's recent summaries plus the project's promoted memories, refreshing that
snapshot without echoing it, because the harness injects those files itself. Codex reads the
conversation's context window under a byte budget and never reads, replays or writes the
snapshot. Every block is fenced before it is returned, insights ride beside the context
rather than inside it, a section that cannot be read contributes nothing instead of failing
the restore, and one project-database connection serves the whole call.

`lcm_grep` can restrict retrieval to `summary_id`: the selected summary, the source
summaries it replaced recursively, and their linked messages. The scope follows
`summary_parents` and `summary_messages`, rather than timestamps, and applies before
search limits. Message matches name all covering leaf and condensed summaries in
`summaryIds`, ordered by depth then id; an unsummarized message has an empty list.
Summary matches carry their own `summaryId`.

## Expansion system

When summaries are too compressed for a task, agents use `lcm_expand` to recover detail.

### How it works

1. Agent calls `lcm_expand` with a `nodeId` (summary ID) and optional `depth`.
2. lcm traverses the DAG from the given node, following parent links down to source messages.
3. Source message content is assembled and returned to the agent (bounded by the requested `depth`).
4. The agent receives the full decompressed content for the requested depth.

For broader recall, agents can first use `lcm_grep` or `lcm_search` to find relevant summary IDs, then call `lcm_expand` on the results that need more detail.

## Large file handling — planned, not implemented

Nothing below runs today. The storage layer exists — a `large_files` table, read by
`getLargeFile` on the summary store — but no config key, threshold or ingestion path
writes such a record.
Ingestion scrubs and stores messages whole. This section describes the intended design, so
that the half already built is not mistaken for a working feature.

The intent: files embedded in user messages (typically via `<file>` blocks from tool output)
would be checked at ingestion:

1. Parse file blocks from message content.
2. For each block exceeding `largeFileTokenThreshold` (default 25k tokens):
   - Generate a unique file ID (`file_` prefix)
   - Store the content to `~/.lossless-claude/projects/<project-hash>/files/<file_id>.<ext>`
   - Generate a ~200 token exploration summary (structural analysis, key sections, etc.)
   - Insert a `large_files` record with metadata
   - Replace the file block in the message with a compact reference
3. The `lcm_describe` tool can retrieve full file content by ID.

The point of it: one large file paste would stop consuming the whole context window, while
the content stayed reachable.

## Session reconciliation

Session reconciliation uses each transcript source's recovery checks before applying a delta.

1. A Claude transcript resumes from its durable byte cursor (`src/transcript-source.ts`).
   The checkpoint must match the stored message count, database file identity, current
   parser shape and redaction rules. The redaction identity is a SHA-256 digest of built-in,
   global and project rules, never the raw patterns, which can contain literal secrets.
   The shared reader checks the transcript's device/inode,
   size, record boundary and a versioned SHA-256 fingerprint of the first and last 4 KiB of
   the consumed prefix. These bounded samples detect common same-inode rewrites; arbitrary
   edits outside the samples are outside the shared reader's stable-prefix contract.
   Claude Code's in-place rewrite behavior is unconfirmed; recovery never depends on it
   being unable to replace or truncate a file. A missing or invalid checkpoint causes a
   full read. A session validated once stays guarded when its database or transcript path
   changes: its checkpoint no longer resumes, and a stored history that is not a prefix of the
   transcript stalls capture instead of falling back to count-based capture. An unknown or older parser-shape stamp triggers a full stored-prefix comparison before the transcript is sliced
   at the stored message count. An aligned history is restamped during capture; a mismatch stalls
   for rebuild. The stored conversation is the ground truth for how much of the file lcm has.
   Once compaction has written its event rows into the session, the
   slice is taken only after the stored messages, oldest conversation first, are verified as
   today's transcript parse's prefix under the current redaction rules; a stored `[REDACTED]` span of a
   pattern since removed or narrowed matches the text it replaced. A role-tagged conversation
   captured in an older tool shape also stalls when its stored prefix differs, including when
   later capture mixed older and current shapes. Rebuild classifies against both shapes and
   replaces a repairable session with today's parse. A conversation captured before
   role tagging (`role_tagging IS NULL`) that has not grown, its rows matching the older
   tool-content parse row for row with no newer entry after them, is aligned and left alone.
   Once it has grown it is repairable when every stored row's content occurs in today's or
   the older tool-content parse regardless of role; otherwise its lost rows keep it ambiguous. The older tool-content parse reproduces the pre-role-tagging parser's
   content, including tool output without an error marker. A new cursor is issued only for
   history whose prefix comparison succeeded, or for a session captured from the start.
   Legacy histories exempt from the existing guard keep count-based capture if they cannot
   be compared, and receive no trusted cursor. SQLite triggers invalidate Claude's proof
   on changes to stored content, order, conversation provenance or compaction classification;
   appending an excluded compaction event leaves it valid. An existing session's first cursor
   also remembers a scrubbed, normalized digest of the tail captured during enrollment:
   the next capture compares just those newly stored rows once, including after a restart.
   The post-compaction memo (up to 128 sessions) remains for full recovery reads, where it
   can compare only a newly stored overlap after matching stored/transcript fingerprints.
   Normal cursor resumes neither reparse old transcript bytes nor hash or hydrate the old
   stored prefix; restarting does not discard the durable proof. Other redaction rules, a
   parser-shape change, database replacement or a rebuild require recovery validation.
   On a guarded mismatch capture stops, with
   nothing written: a session an earlier lcm captured
   after a compaction can hold skipped and repeated messages, and appending to it would repeat
   the damage. `lcm import --provider claude --rebuild` repairs it (see
   [Import](import.md#rebuilding-claude-code-sessions)).
2. A Codex transcript resumes from the byte-offset cursor persisted with the last write, and
   the cursor is trusted only while it accounts for exactly the stored messages.
3. When the cursor cannot be trusted — a replaced, truncated or extended file — Codex re-reads
   the whole file and the capture verifies the stored prefix, after current redaction rules
   have been applied to both sides (the same allowance for a removed pattern's `[REDACTED]`
   spans), before accepting the suffix. A shorter paginated subagent rollout can instead
   re-anchor when its nonempty parsed messages exactly equal the stored tail in role and
   normalized content under current redaction, with parent identity and a valid
   `subagent_history_start_ordinal`. The cursor retains the total stored count;
   messages and summaries are preserved. Other paginated recovery mismatches become
   terminal per-session guards in the existing `subagent-guard-failures.json` sidecar.
   Capture skips them before reading the transcript, even after restart, file growth or
   an unrelated lcm upgrade. Each guard records `CODEX_RECOVERY_RULE_VERSION` from
   `src/transcript-source.ts`; changing that recovery rule retries older guards once
   on the next capture, including legacy guards without a rule version. Doctor reports
   the retained reason without requiring a matching file fingerprint and names
   `lcm import --provider codex --retry-blocked --session <id>` in the affected project.
   Without `--session` it clears every terminal Codex guard in that project; `--all`
   clears guards in every project with a project record. It requires `--provider codex`
   and rejects `--replay`, `--rebuild`, `--dry-run`, and `--all` with `--session`.
   The command clears only terminal Codex guards through `/capture-retry`, under the
   project queue and mutation lease. The next capture rechecks alignment under current
   redaction rules; a remaining mismatch is blocked again and recorded once. Messages,
   summaries and cursors are preserved. The guard is tied to the project database identity. See
   [the design and upstream evidence](design/codex-paginated-history.md).
4. An OMP transcript uses the same cursor, but its file is a tree: each read keeps only the
   entries on the `parentId` chain from the file's last entry. Stored history is therefore
   the file's messages in order but not always its prefix. A recovery scan continues the
   file's live path when stored history is a prefix of it; otherwise it requires that order
   and accepts the live-path messages after the last stored one. Stored history here is every
   conversation of the session, oldest first, and the cursor, saved against the newest, counts
   them all. A `/clear` after the last stored message opens its conversation unless one already
   carries it; one inside stored history is never split out.

This covers a session whose messages reached the transcript while lcm was down or killed, and
a file that grew or was rewritten between two runs.

## Operation serialization

Ordinary ingest and compact requests enter a **per-project** queue keyed by `projectId(cwd)`
(`src/daemon/project-queue.ts`), not by session. Each queue turn runs exclusively, but compaction
yields its turn while awaiting external language detection or summarization. Other captures can
then finish without waiting for that model call. Compaction reenters the queue before reacquiring
its per-project mutation lease and resuming database work. The lease serializes database mutations
while a queue turn is yielded; a yielded compaction still counts as pending project work. Queue
turns remain FIFO, though independent compactions can finish in a different order when their
model calls take different times. Replay retains its session order because it awaits each ingest
and compact response before advancing. `/compact` also guards each `(projectId(cwd), session_id)`
through the whole request, including model waits. A second direct request for that session waits
for the first to finish, then reads the current context; deadline-bound PreCompact requests and
`skip_ingest` callers (including replay and `lcm compact`) receive the existing busy/skip outcome.
The guard uses the session because `/compact` resolves its newest conversation only after admission;
an OMP clear can open another conversation under the same session id. Different sessions of one
project can still summarize concurrently, subject to a named endpoint's `maxConcurrent` limit.
The endpoint semaphore (`src/llm/endpoint-concurrency.ts`) is shared across all projects
and summarizer instances using that name. Its HTTP adapters admit live before background
and background before timeline, FIFO within each class, and leave running requests to finish.
`/compact` classifies PreCompact as live
from `capture_required` or OMP's `precompact_verified`; SessionEnd (including the legacy
hook fallback) and SessionStart catch-up send `work_class: "live"` because they also use
`skip_ingest`. Other `skip_ingest` callers, including import replay and batch compact with
or without replay, are background.
Direct compactions default to live. `SummarizeContext.workClass` carries that choice through
the provider chain, retries and fallback to the OpenAI and Anthropic adapters.

Live slot waits expire after the endpoint's `timeoutMs` (default 600000 ms), allowing
fallback even when the daemon continues after PreCompact's 120-second client deadline.
Background slot waits have no deadline; each admitted HTTP request still has a fresh
`timeoutMs` deadline. Background is admitted whenever the live queue is empty. Lifecycle
compactions arrive in finite bursts, with SessionStart catch-up capped by
`compaction.autoCompactSessionStartMax`, so replay progresses in the gaps. Continuous live
saturation can defer background indefinitely under this strict priority rule.

A required PreCompact Capture bypasses an occupied queue
and takes the mutation lease directly so it can finish within the hook deadline. A same-session
`/ingest` can likewise append while a summary waits: the pending model call uses message IDs
selected before the capture, and newly captured messages remain in context for a later selection.
A Claude rebuild of that session (`/ingest` with `rebuild`) replaces those messages instead, so it
waits for the compaction to finish and holds the session guard until the rebuild is written.
Replay `--restart` uses the same guard for every session in its manifest, then
clears their summaries and context under the queue and mutation lease.
An OMP pre-compaction request whose Capture was separately verified skips its lcm summary if
the project queue has work that has not yielded, or a mutation lease is outstanding, including
when another request enters during awaited summarizer setup; admission is rechecked immediately
before enqueue. A required PreCompact request uses the same busy check before summarizer setup.
Another session's compaction waiting on an external model has yielded both its queue turn and
mutation lease, so it does not make PreCompact busy. The same session's in-flight compaction
always makes its PreCompact summary busy. `hasQueuedProjectWork` still reports all pending queue
requests, including yielded ones; admission uses `hasBlockingProjectWork` instead.

`/promote` and `/promote-events` hold the same mutation lease for their whole run. They walk
every summary or event not yet promoted, and `node:sqlite` is synchronous, so each yields to the
event loop between items (`yieldToEventLoop`) to keep `/health` and other projects answering;
the lease is what stops a second run from reading the not-yet-promoted set before the first
has written it.

A project's `meta.json` is written by routes on different sessions of the same project, so the per-project queue is not what covers it; it needs no queue of its own because each update in `src/daemon/project-meta.ts` is a single synchronous read-modify-write that nothing in the process can interleave with. Writers in other processes are outside the daemon's trust boundary, as they are for the database.

## Authentication

lcm needs an LLM only for summarization, and it resolves the credential the way the daemon
config does:

1. `llm.apiKey` in `~/.lossless-claude/config.json`, or with named endpoints each endpoint's
   own `llm.providers.<name>.apiKey` — the value may interpolate an environment variable as
   `${NAME}`. An endpoint whose variable is unset is left out of the summarizer chain instead
   of sending no key; the rest of the config loads.
2. `ANTHROPIC_API_KEY`, read only for an `anthropic` provider or endpoint (directly, or as the
   `session` provider's fallback) with no key configured.

There is no profile store to consult: the process-backed providers (`claude-process`,
`codex-process`, `copilot-process`, `omp-process`) authenticate through their own CLI's login, so
lcm never sees their credentials.

### Declared agent summarize workers

Declared Claude Code, Codex and OMP hook workers have durable whole-session capture exclusion in `summarize_workers`. Enrollment installs gates and a tombstone and refuses retained conversation content or tool events without deleting them. Its project lease serializes one process; SQLite's write transaction protects the history check across processes. The sidecar enrollment gate is transactional, and per-row event insertion checks it before inserting. Parser-confirmed copied successful claim payloads stop future capture while preserving stored history, with the recovery reason retained for doctor. Only descendants discovered on disk under an enrolled worker's own Claude transcript directory permit history cleanup. Discovery runs before the write transaction and is recorded in `summarize_workers`; hot-path gates use database lookups. Request-supplied ancestry may refuse the current write but never persists exclusion or changes enrollment. Finishing or resuming never lifts permanent exclusion. Capture, rebuild, scan, import, replay and compaction check the permanent gate. See [the design](design/agent-summarize-workers.md).
