# Structure lives in `message_parts`, not the events database

**Status:** accepted, 2026-09-09. Scopes #419 and #421; no schema change is made by this document.

lcm has two places that already hold per-message facts: the permanent conversation
store (`message_parts`) and the passive-learning events database, whose extractors
already emit `skill_use` and `subagent_dispatch`. Reusing the events database would
have cost nothing to build. We put structure in `message_parts` anyway, because the
events database has a different lifetime and scope — it feeds promotion and is not the
record a search is expected to filter — while `message_parts` already carries
`part_type` and the unused `subtask_prompt` / `subtask_desc` / `subtask_agent` columns
that this data was shaped for.

## Consequences

`message_parts.part_type` is constrained by `CHECK (part_type IN (...))`. Adding values
to it requires rebuilding the table, on project databases reaching 122 MB. We accepted
that cost, and it is the reason the parent-link work (#419, a plain column addition) is
separate from the skill and slash-command work (#421, the rebuild).

Backfills against this table are `UPDATE`, never `DELETE`: compacted conversations are
protected by `ON DELETE RESTRICT` on `summary_messages.message_id`, so SQLite refuses
to delete and re-ingest them.
