---
"@lossless-claude/lcm": patch
---

fix: subagent transcripts dedupe by session id and ingest independently, and attribution backfills on an existing row

Two subagent transcripts sharing a basename at different depths under
`subagents/` now dedupe to the first one found instead of one call slicing
the second transcript by the first one's stored message count. One subagent
transcript that fails to parse or capture no longer aborts `/ingest` for its
siblings — the failure is logged and the loop continues. A subagent captured
before its `.meta.json` sidecar existed now gets its parent, type and
description filled in on the next `/ingest` that finds the sidecar, instead
of staying unattributed forever.
