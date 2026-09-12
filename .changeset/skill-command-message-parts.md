---
"@lossless-claude/lcm": patch
---

feat: record skill invocations and slash commands as `message_parts` structure

A skill's name arrives in the `Skill` tool_use's own `input.skill` field, and a slash
command arrives as a `<command-name>` block — both already reach the database, but only
as a substring of a message body, so nothing could filter on them. `parseTranscript` now
extracts both into `message_parts` rows (`skill` / `command`), used by both CLI import and
the daemon's `/ingest`. Existing databases get their `part_type` `CHECK` rebuilt to admit
the two new values, then backfilled once, both straight from stored message content, no
disk read: slash commands from the `<command-name>` block, and skill names from Claude
Code's own "Launching skill: `<name>`" follow-up line, which is stored verbatim.
