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
- **createdAt** — Insertion timestamp

Each message also has **message_parts** — structured content blocks that preserve the original shape. The part types are `text`, `reasoning`, `tool`, `patch`, `file`, `subtask`, `compaction`, `step_start`, `step_finish`, `snapshot`, `agent`, `retry`, `skill` (a skill expansion) and `command` (a slash command invocation); see `MessagePartType` in `src/store/conversation-store.ts`. This allows the assembler to reconstruct rich content when building model context, not just flat text.

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
- **earliestAt / latestAt** — Time range of source material
- **descendantCount** — Total number of ancestor summaries (transitive)
- **fileIds** — References to large files mentioned in the source
- **tokenCount** — Estimated tokens

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

### The project record

Beside each project's database sits `meta.json`, the project record: `cwd`, the git identity (`git`), the detected author `language` and `languageDetectedAt`, and the `lastIngest`, `lastCompact` and `lastPromote` timestamps. `src/daemon/project-meta.ts` is its only reader and writer: every other module reads through `readProjectMeta` / `readProjectMetaIn` and updates by key through `updateProjectMeta` / `updateProjectMetaIn`, which merge a patch into the current record in one synchronous read-modify-write and land it through a temporary file and a rename, so a crash mid-write cannot leave a torn file. The cwd-keyed update always re-asserts `cwd`, so a record is never left without the key that enumeration (`lcm export --all`, `lcm compact --all`, the compaction sweep, stats) selects on.

One corrupt-file policy, whichever code path meets the file first: a read treats an unparsable file as absent; an update moves it aside as `meta.json.corrupt-<timestamp>` and starts again from the caller's keys. The alternatives both lose something silently — refusing to write leaves the project invisible to every enumeration until someone deletes the file by hand, and overwriting in place discards the evidence — while moving aside heals the project on its next write and keeps the bad bytes for inspection.

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
whose transcript is unchanged since its last successful ingest or a Claude 400 rejection —
an in-memory fingerprint
per transcript path, the parent file's `(size, mtimeMs)` plus the same for every file
under its `subagents/` tree except `journal.jsonl` (each subagent transcript and its
`.meta.json` sidecar), since a subagent transcript grows, and its attribution is filled in
once its sidecar appears, through the parent's own `/ingest` while the parent file itself
may not change; the fingerprint is recorded only once the ingest for that pass succeeds
without reporting `incomplete` — a subagent transcript that could not be captured, or a
failed tool-call model backfill, which the scan asks `/ingest` to run before replying
(`backfill_before_reply`) — so any of those is retried next pass. A Claude 400 rejection,
including a prefix-guard failure, is retried when that fingerprint changes; other failures remain retryable on the next
pass. The scan never marks a session complete. The SessionStart catch-up sweep is a
different thing and never reaches `/ingest`: it finds conversations a killed session left
uncompacted and asks `/compact` for them directly, with `skip_ingest: true`
(`docs/configuration.md#sessionstart-catch-up-sweep`). PreCompact can Capture inside `/compact`, before lcm summarization, with
separate outcomes for the two operations. `POST /session-end` hands the whole end-of-session sequence to the daemon —
ingest, then compact, promote and session-complete — after acknowledging with `202`, so a
host that stops waiting for the hook cannot drop the steps behind it.

Every route that lands transcript content in `messages` — `/ingest`, the subagent path inside it, and `/compact` — writes through one module, `src/capture.ts` (`SessionCapture`). It owns what "already stored" means (the delta past the message count of the session's conversations), scrubbing, the bulk insert, `context_items`, `message_parts`, redaction counts, the Codex cursor and `session_ingest_log`. `/session-complete` records a session in that log, with its completion time, when the session ends. `/ingest` and `lcm import` skip a Claude Code session so recorded (Codex and OMP always reach capture, whose read may recover a deferred tail) unless its transcript file was modified after that time: a resumed session appends to the same file under the same session id, so its new turns are captured, and completing it again moves the time forward. When the caller passes no attribution and the transcript is a subagent transcript, the module reads the `.meta.json` sidecar itself, so which route sees a session first does not change what is stored about it.

Claude conversations record `parser_shape` alongside `role_tagging`. The column is NULL for rows created before the stamp existed: their capture shape cannot be inferred from age or role tagging. Structured `/ingest` uses the `structured` stamp because its messages bypass the Claude parser. A `/compact` hook summarizes those stored messages directly; a later transcript capture still verifies them. Before Claude slices a fresh parse at the stored message count, an unknown or different stamp triggers a comparison of the entire stored history with today's parse under the current redaction rules. If the stored history is a prefix, capture appends the tail and stamps every conversation in the same transaction. If it differs, capture writes nothing and reports the rebuild instructions. Verification costs one full comparison per session after a parser-shape change; later captures use the matching stamp and the existing post-compaction guard and memo. A repairable rebuild replaces damaged history and stamps it. When `parseTranscript` changes the rows or fields it emits, bump `CLAUDE_PARSER_SHAPE` and add the fixture snapshot named for the new value. Codex and OMP use versioned byte cursors and their own recovery checks instead of this count-based stamp.

Capture replaces NUL in scrubbed message content with U+FFFD before the message and its full-text index are written. Leaf compaction reads that same stored content. A stored row written before this rule can read back cut at its first NUL; the compacted-session guard accepts that prefix only when the transcript has a NUL at the cut, and rebuild can replace the row with the full normalized message.

`lcm doctor` reports what none of those routes captured (`claude-capture`, category `Capture`, `src/doctor/transcript-check.ts`): per project lcm tracks, and for the current directory's project, the Claude Code transcripts `lcm import` would find whose session has no stored message and is not complete by the rule above, with their count and the most recent path; the fix is `lcm import --provider claude` in that project. It lists directories, stats transcripts, reads subagent `.meta.json` sidecars and reads each project database read-only, never a transcript, so its cost follows the number of transcripts, not their size. A transcript modified in the last 15 minutes is left out, since its session may be in progress and the 10-minute scan has not had a pass at it. Since it never reads a transcript, one holding no message at all, which capture stores nothing for, stays listed. It does not compare a transcript's modification time with its stored messages', because Claude Code keeps appending lines that hold no message after the last one captured; so it does not report a session captured in part, including one whose capture stalls on the compacted-session check (`docs/import.md#rebuilding-claude-code-sessions`), nor a transcript under a Claude Code project directory lcm does not track, other than the current one. Two tracked projects whose paths map to the same Claude Code project directory (the directory name replaces every non-alphanumeric character with `-`) cannot be told apart, so both are listed as not checked; so is a project whose `meta.json` cannot be read.

Hook operation evidence is separate from Capture: the project's events sidecar aggregates tool-capture and daemon pre-compaction outcomes by Session, harness, hook, operation, delivery or execution status, and reason. Individual failure codes are retained separately. Short-lived Claude Code command and Codex lifecycle hooks append bounded metadata to a local log without loading SQLite at startup. The Claude Code function module and OMP keep bounded local snapshots because their host adapters cannot use the sidecar write path when the daemon is unavailable; OMP forces its final shutdown snapshot. `lcm doctor -v` aggregates these sources; missing evidence never establishes that an expected hook did not run.

What a transcript holds beyond what is stored is answered by one interface, the transcript source (`src/transcript-source.ts`), with an adapter per harness; `SessionCapture` is its only caller, so a route names the client and the session and never chooses how the file is read. Each adapter owns its own delta model and validation: the Claude adapter locates the transcript (the caller's path, or Claude Code's own location for the session), re-parses the file and returns what follows the stored count; the Codex adapter validates the path against Codex's session directories, resumes from the byte-offset cursor persisted with the last write — trusted only while it accounts for exactly the stored messages — and, when it cannot resume, re-reads the whole file and verifies the stored prefix under the current redaction rules before anything is written. The adapter's answer also carries the model backfill for the session's tool-call events, so `/ingest` runs it after the response (before it for a caller that sets `backfill_before_reply`) without knowing which transcript format supplied it. A transcript an adapter refuses (a Codex path outside its bases, metadata naming another project or session, a file shorter than the stored history) is a `TranscriptSourceError`, which `/ingest` and `/compact` answer with 400.

When `/ingest` processes a session it also looks for that session's subagent transcripts under `<project>/<session_id>/subagents/`, recursively (a workflow run writes its own subagents under `subagents/workflows/wf_<id>/`); `journal.jsonl` is not a transcript and is skipped. `discoverSubagentTranscripts` in `src/subagent-attribution.ts` is the one walker of that directory, shared with `lcm import` and the migration backfill, so every path captures the same set with the same attribution. Two transcripts sharing a basename (so the same `sessionId`) at different depths dedupe to the first found, in walk order; the walker logs and drops every later duplicate instead of one call slicing a second transcript by the first one's stored count. The lookup is scoped to that one session directory, never a walk of the projects tree. Each subagent transcript is captured and ingested independently — one failing to parse is logged and skipped, never stopping its siblings or failing the parent's `200`, which then carries `incomplete: true` — and attributed to the parent session (see CONTEXT.md for the terms); a conversation row created before its `.meta.json` sidecar existed gets its attribution filled in on the next `/ingest` that finds it, once the sidecar appears.

### Leaf compaction

The **leaf pass** converts raw messages into leaf summaries:

1. Identify the oldest contiguous chunk of raw messages outside the **fresh tail** (protected recent messages).
2. Cap the chunk at `leafChunkTokens` (default 20k tokens).
3. Concatenate message content with timestamps.
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
wiping anything it asks the daemon (`/status`) whether it is still compacting
a session in those projects and refuses with an error if so. A daemon that is
not running counts as idle; one that answers `/status` with an error (bad
token, 5xx) makes `--restart` refuse, since it cannot confirm idleness. The
check is not atomic with the wipe, so a compaction that starts after it can
still race.

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
2. Render each block as plain text and fence it — summaries join their stored `content` and
   are returned as one `<recent-session-context>` block, promoted memories as their own
   fenced block, passive-capture insights beside them.
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

1. A Claude transcript is re-parsed in full (`src/transcript-source.ts`). An unknown or older
   parser-shape stamp triggers a full stored-prefix comparison before the transcript is sliced
   at the stored message count. An aligned history is restamped during capture; a mismatch stalls
   for rebuild. The stored conversation is the ground truth for how much of the file lcm has.
   Once compaction has written its event rows into the session, the
   slice is taken only after the stored messages, oldest conversation first, are verified as
   today's transcript parse's prefix under the current redaction rules; a stored `[REDACTED]` span of a
   pattern since removed or narrowed matches the text it replaced. A role-tagged conversation
   captured in an older tool shape also stalls when its stored prefix differs, including when
   later capture mixed older and current shapes. Rebuild classifies against both shapes and
   replaces a repairable session with today's parse. A conversation captured before
   role tagging (`role_tagging IS NULL`) remains ambiguous in rebuild: today's parser cannot
   reproduce its older rows. The daemon remembers in memory the prefix it last validated for each session (up to 128
   sessions; a restart forgets them). A later capture hashes the stored prefix, together with the
   database's and the conversations' identity, and the transcript's prefix; when both hashes and
   the redaction rules match what it remembered, only the messages stored since are compared.
   Anything else (fewer stored messages, a replaced database or transcript file, other redaction
   rules, a rebuild) compares the whole prefix again. On a mismatch capture stops, with
   nothing written: a session an earlier lcm captured
   after a compaction can hold skipped and repeated messages, and appending to it would repeat
   the damage. `lcm import --provider claude --rebuild` repairs it (see
   [Import](import.md#rebuilding-claude-code-sessions)).
2. A Codex transcript resumes from the byte-offset cursor persisted with the last write, and
   the cursor is trusted only while it accounts for exactly the stored messages.
3. When the cursor cannot be trusted — a replaced, truncated or extended file — Codex re-reads
   the whole file and the capture verifies the stored prefix, after current redaction rules
   have been applied to both sides (the same allowance for a removed pattern's `[REDACTED]`
   spans), before accepting the suffix.
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

Ordinary ingest and compact requests are serialized **per project** — the queue is keyed by
`projectId(cwd)` (`src/daemon/project-queue.ts`), not by session — so two conversations of the same
project wait on each other while different projects do not. `/compact` adds its own per-session
guard on top, which is what keeps one session from compacting twice at once. A required PreCompact
Capture bypasses a queue occupied by an LLM call so it can finish within the hook deadline.
It shares a short per-project mutation lease with ingest and compact database work; compaction
releases that lease only while awaiting the external LLM and reacquires it before writing.
An OMP pre-compaction request whose Capture was separately verified skips its lcm summary if
the project queue is occupied, including when another request enters during awaited summarizer
setup; admission is rechecked immediately before enqueue.

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
