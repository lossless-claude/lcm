---
"@lossless-claude/lcm": patch
---

refactor: one transcript-source interface behind `/ingest` and `/compact`, with a Claude and a Codex adapter

Reading a transcript now goes through one interface with an adapter per
harness, called only by the capture module; neither `/ingest` nor `/compact`
branches on the client to decide how a transcript is read. `/compact` with a
Codex `transcript_path` now ingests that session's delta through the Codex
cursor, where it previously validated the path against Claude Code's
transcript directory and read nothing, and answers 400 for a Codex transcript
the adapter refuses instead of silently skipping it.
