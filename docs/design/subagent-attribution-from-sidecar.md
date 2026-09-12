# Subagent attribution comes from the `.meta.json` sidecar

**Status:** accepted, 2026-09-12. Implements #419.

## What it is

Every subagent transcript Claude Code writes to
`<projectDir>/<parent-session-id>/subagents/agent-<id>.jsonl` has a `.meta.json` sidecar
next to it. `conversations` gains three columns — `parent_session_id`, `subagent_type`,
`subagent_desc` — filled from that sidecar when `findSessionFiles` (`src/import.ts`)
discovers the transcript, and backfilled once for conversations already ingested
(`src/db/migration.ts`).

## Why the sidecar, not the parent transcript

The parent session's own transcript already carries the dispatch: a `tool_use` block
naming the `Agent` tool with `subagent_type` and `description` in its input, matched to
the child by `agentId` in the corresponding `tool_result`. That join works — it is how
this issue's investigation first measured `agentType`/`description` coverage — but it
requires parsing the parent's transcript, which can be many megabytes, to recover two
strings that are already sitting in a few-hundred-byte JSON file beside the child.

The sidecar is measured at 100% coverage over every subagent transcript on disk (1204/1204
at investigation time). Reading it costs one `readFileSync` per subagent, already being
walked by `findSessionFiles`; reading the parent transcript would mean opening and
parsing a second, unrelated, and potentially much larger file for every subagent found.

`parent_session_id` follows the same logic in reverse: the directory name that owns
`subagents/` already gives the immediate dispatcher for every transcript (1204/1204,
verified). The 37 sidecars that also carry `parentAgentId` (a dispatch nested inside
another subagent) resolve to a sibling `agent-<id>.jsonl` in the same directory, never to
the top-level owning session — verified 37/37. So `parentAgentId`, when present, is
preferred over the directory name; the directory name is the fallback, not a second
source that needs reconciling against it.

A third source exists and is deliberately not read: newer-format transcripts carry
`parentSessionId` on their header line. That value is always the owning session — the
same thing the directory name already gives for every transcript, sidecar or not.
Reading a transcript file to recover what its own path already encodes has no payoff.

## Why not `message_parts`

`message_parts` has unused `subtask_agent` / `subtask_desc` columns that look purpose-built
for this. They are a dead end here: the `INSERT` in `src/store/conversation-store.ts`
does not list the `subtask_*` columns, and the only writer of parts at all is
`src/compaction.ts` — no import path writes parts, so reaching those columns means
building the parts pipeline from scratch. That pipeline is real, scoped, and separate
(#421, structured skill/slash-command extraction from `parseTranscript`); duplicating a
slice of it here to reach three columns nothing else populates yet would create two
writers into the same table with different rules for what counts as "this row exists,"
which is exactly the kind of drift `message-parts-vs-events-db.md` already flags as a
cost worth avoiding. Session-level attribution belongs on `conversations`, one row per
session, not `message_parts`, one row per structured fragment inside a session.

## Backfill: gated by a marker, not by "still has nulls"

The natural backfill guard — "does this database have any `agent-%` conversation with
`parent_session_id IS NULL`?" — is wrong on its own: a conversation whose transcript was
deleted from disk after import stays permanently unresolvable, so that guard would keep
being true forever and re-walk all of `~/.claude/projects` on every single
`runLcmMigrations` call (every daemon route, on every project database) for the life of
the installation. Instead, a singleton table
(`subagent_attribution_backfill`, `id INTEGER PRIMARY KEY CHECK (id = 1)`, the same shape
as `session_instructions`) records that the sweep ran, plus how many conversations it
could not resolve. The sweep itself still only touches disk when there is at least one
unresolved `agent-%` row — most project databases never dispatched a subagent — and it is
`UPDATE`-only: `summary_messages.message_id` is `ON DELETE RESTRICT`, so a compacted
conversation can never be deleted and re-ingested to pick up new columns.
