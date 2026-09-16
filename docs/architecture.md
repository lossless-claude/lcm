# Architecture

This document describes how lcm works internally — the data model, compaction lifecycle, context assembly, and expansion system.

## Data model

### Conversations and messages

Every Claude Code session maps to a **conversation**. The first time a session ingests a message, LCM creates a conversation record keyed by the runtime session ID.

Messages are stored with:
- **seq** — Monotonically increasing sequence number within the conversation
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction of the message
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

- **Find the conversation of a session** — `getOrCreateConversation` opens it on first capture and fills attribution in once a sidecar names a parent; `getConversationBySessionId` answers it afterwards; `latestActiveConversation` is what a session that captured nothing yet is shown instead.
- **Append a delta** — `createMessagesBulk` writes the messages past the stored count, `appendContextMessages` puts them at the end of the context, `createMessageParts` keeps their structure; `getMessageCount`, `getMaxSeq` and `getMessages` describe what is stored so the next delta starts after it.
- **Read the context window** — `getContextItems` for compaction's view of the whole list, `readContextWindow` for a restore's view of its end (the last N summaries and the last N user/assistant messages, with a plain-messages fallback for a conversation captured before context items were materialised), `getContextTokenCount` and `getDistinctDepthsInContext` for the compaction triggers.
- **Replace a range with a summary** — `insertSummary`, `linkSummaryToMessages` / `linkSummaryToParents` for its lineage, then `replaceContextRangeWithSummary`; `resetConversationContext` undoes every summary of a conversation and rebuilds the context from its messages.
- **Read summaries** — by id, by conversation, deepest-first for a session's restore, newest-first across the project, or as a subtree under `lcm_expand`.
- **Search** — `searchMessagesSync` / `searchSummariesSync`, full-text with a LIKE fallback, or regex.

### The project record

Beside each project's database sits `meta.json`, the project record: `cwd`, the git identity (`git`), the detected author `language` and `languageDetectedAt`, and the `lastIngest`, `lastCompact` and `lastPromote` timestamps. `src/daemon/project-meta.ts` is its only reader and writer: every other module reads through `readProjectMeta` / `readProjectMetaIn` and updates by key through `updateProjectMeta` / `updateProjectMetaIn`, which merge a patch into the current record in one synchronous read-modify-write and land it through a temporary file and a rename, so a crash mid-write cannot leave a torn file. The cwd-keyed update always re-asserts `cwd`, so a record is never left without the key that enumeration (`lcm export --all`, `lcm compact --all`, the compaction sweep, stats) selects on.

One corrupt-file policy, whichever code path meets the file first: a read treats an unparsable file as absent; an update moves it aside as `meta.json.corrupt-<timestamp>` and starts again from the caller's keys. The alternatives both lose something silently — refusing to write leaves the project invisible to every enumeration until someone deletes the file by hand, and overwriting in place discards the evidence — while moving aside heals the project on its next write and keeps the bad bytes for inspection.

## Compaction lifecycle

### Ingestion

When Claude Code processes a turn, it calls the context engine's lifecycle hooks:

1. **bootstrap** — On session start, reconciles the JSONL session file with the LCM database. Imports any messages that exist in the file but not in LCM (crash recovery).
2. **ingest** / **ingestBatch** — Persists new messages to the database and appends them to context_items.
3. **afterTurn** — After the model responds, ingests new messages, then evaluates whether compaction should run.

Every route that lands transcript content in `messages` — `/ingest`, the subagent path inside it, and `/compact` — writes through one module, `src/capture.ts` (`SessionCapture`). It owns what "already stored" means (the delta past the conversation's message count), scrubbing, the bulk insert, `context_items`, `message_parts`, redaction counts, the Codex cursor and `session_ingest_log`. When the caller passes no attribution and the transcript is a subagent transcript, the module reads the `.meta.json` sidecar itself, so which route sees a session first does not change what is stored about it.

What a transcript holds beyond what is stored is answered by one interface, the transcript source (`src/transcript-source.ts`), with an adapter per harness; `SessionCapture` is its only caller, so a route names the client and the session and never chooses how the file is read. Each adapter owns its own delta model and validation: the Claude adapter locates the transcript (the caller's path, or Claude Code's own location for the session), re-parses the file and returns what follows the stored count; the Codex adapter validates the path against Codex's session directories, resumes from the byte-offset cursor persisted with the last write — trusted only while it accounts for exactly the stored messages — and, when it cannot resume, re-reads the whole file and verifies the stored prefix under the current redaction rules before anything is written. The adapter's answer also carries the model backfill for the session's tool-call events, so `/ingest` runs it after the response without knowing which transcript format supplied it. A transcript an adapter refuses (a Codex path outside its bases, metadata naming another project or session, a file shorter than the stored history) is a `TranscriptSourceError`, which `/ingest` and `/compact` answer with 400.

When `/ingest` processes a session it also looks for that session's subagent transcripts under `<project>/<session_id>/subagents/`, recursively (a workflow run writes its own subagents under `subagents/workflows/wf_<id>/`); `journal.jsonl` is not a transcript and is skipped. `discoverSubagentTranscripts` in `src/subagent-attribution.ts` is the one walker of that directory, shared with `lcm import` and the migration backfill, so every path captures the same set with the same attribution. Two transcripts sharing a basename (so the same `sessionId`) at different depths dedupe to the first found, in walk order; the walker logs and drops every later duplicate instead of one call slicing a second transcript by the first one's stored count. The lookup is scoped to that one session directory, never a walk of the projects tree. Each subagent transcript is captured and ingested independently — one failing to parse is logged and skipped, never stopping its siblings — and attributed to the parent session (see CONTEXT.md for the terms); a conversation row created before its `.meta.json` sidecar existed gets its attribution filled in on the next `/ingest` that finds it, once the sidecar appears.

### Leaf compaction

The **leaf pass** converts raw messages into leaf summaries:

1. Identify the oldest contiguous chunk of raw messages outside the **fresh tail** (protected recent messages).
2. Cap the chunk at `leafChunkTokens` (default 20k tokens).
3. Concatenate message content with timestamps.
4. Resolve the most recent prior summary for continuity (passed as `previous_context` so the LLM avoids repeating known information).
5. Send to the LLM with the leaf prompt.
6. Normalize provider response blocks (Anthropic/OpenAI text, output_text, and nested content/summary shapes) into plain text.
7. If normalization is empty, re-run it against the whole response envelope (some providers put the text in a top-level field), then retry the request once at temperature 0.05, and only then fall back to deterministic truncation, logging provider/model/block-type diagnostics.
8. If the summary is larger than the input (LLM failure), retry with the aggressive prompt. If still too large, fall back to deterministic truncation.
9. Persist the summary, link to source messages, and replace the message range in context_items.

### Condensation

The **condensed pass** merges summaries at the same depth into a higher-level summary:

1. Find the shallowest depth with enough contiguous same-depth summaries (≥ `leafMinFanout` for d0, ≥ `condensedMinFanout` for d1+).
2. Concatenate their content with time range headers.
3. Send to the LLM with the depth-appropriate prompt (d1, d2, or d3+).
4. Apply the same escalation strategy (normal → aggressive → truncation fallback).
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

SIGINT/SIGTERM let the in-flight compaction settle before exiting, so a resumed
run never duplicates or skips a half-finished session. A second signal exits
at once.

### Three-level escalation

Every summarization attempt follows this escalation:

1. **Normal** — Standard prompt, temperature 0.2
2. **Aggressive** — Tighter prompt requesting only durable facts, temperature 0.1, lower target tokens
3. **Fallback** — Deterministic truncation to ~512 tokens, ending in a `[Truncated from N tokens]` marker (N is the input size)

This ensures compaction always makes progress, even if the LLM produces poor output.

## Context assembly

The assembler runs before each model turn and builds the message array:

```
[summary₁, summary₂, ..., summaryₙ, message₁, message₂, ..., messageₘ]
 ├── budget-constrained ──┤  ├──── fresh tail (always included) ────┤
```

### Steps

1. Fetch all context_items ordered by ordinal.
2. Resolve each item — summaries become user messages with XML wrappers; messages are reconstructed from parts.
3. Split into evictable prefix and protected fresh tail (last `freshTailCount` raw messages).
4. Compute fresh tail token cost (always included, even if over budget).
5. Fill remaining budget from the evictable set, keeping newest items and dropping oldest.
6. Normalize assistant content to array blocks (Anthropic API compatibility).
7. Sanitize tool-use/result pairing (ensures every tool_result has a matching tool_use).

### XML summary format

Summaries are presented to the model as user messages wrapped in XML:

```xml
<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="0"
         earliest_at="2026-02-17T07:37:00" latest_at="2026-02-17T08:23:00">
  <content>
    ...summary text with timestamps...

    Expand for details about: exact error messages, full config diff, intermediate debugging steps
  </content>
</summary>
```

Condensed summaries also include parent references:

```xml
<summary id="sum_def456" kind="condensed" depth="1" descendant_count="8" ...>
  <parents>
    <summary_ref id="sum_aaa111" />
    <summary_ref id="sum_bbb222" />
  </parents>
  <content>...</content>
</summary>
```

The XML attributes give the model enough metadata to reason about summary age, scope, and how to drill deeper. The `<parents>` section enables targeted expansion of specific source summaries.

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

LCM handles crash recovery through **bootstrap reconciliation**:

1. On session start, read the JSONL session file (Claude Code's ground truth).
2. Compare against the LCM database.
3. Find the most recent message that exists in both (the "anchor").
4. Import any messages after the anchor that are in JSONL but not in LCM.

This handles the case where Claude Code wrote messages to the session file but crashed before LCM could persist them.

## Operation serialization

All mutating operations (ingest, compact) are serialized per-session using a promise queue. This prevents races between concurrent afterTurn/compact calls for the same conversation without blocking operations on different conversations.

A project's `meta.json` is written by routes on different sessions of the same project, so the per-session queue does not cover it; it needs no queue of its own because each update in `src/daemon/project-meta.ts` is a single synchronous read-modify-write that nothing in the process can interleave with. Writers in other processes are outside the daemon's trust boundary, as they are for the database.

## Authentication

LCM needs to call an LLM for summarization. It resolves credentials through a three-tier cascade:

1. **Auth profiles** — Claude Code's OAuth/token/API-key profile system (`auth-profiles.json`), checked in priority order
2. **Environment variables** — Standard provider env vars (`ANTHROPIC_API_KEY`, etc.)
3. **Custom provider key** — From models config (e.g., `models.json`)

For OAuth providers (e.g., Anthropic via Claude Max), LCM handles token refresh and credential persistence automatically.
