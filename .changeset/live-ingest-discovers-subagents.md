---
"@lossless-claude/lcm": patch
---

fix: live `/ingest` discovers subagent transcripts, not only `lcm import`

Previously, a subagent transcript reached the database only when someone ran
`lcm import` by hand — `/ingest` parsed only the session's own transcript.
`/ingest` now also discovers that session's `subagents/*.jsonl` transcripts
and ingests each one with the same attribution `lcm import` already writes,
so a session that dispatched agents has their conversations recorded without
any command being run. Re-ingesting the same session does not duplicate
subagent messages, and a session with no subagents is unaffected.
