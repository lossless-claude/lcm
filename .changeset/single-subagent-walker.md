---
"@lossless-claude/lcm": patch
---

Live `/ingest` now captures subagent transcripts nested under a workflow run
(`subagents/workflows/wf_<id>/`), as `lcm import` already did: one directory walker
serves import, live ingest and the migration backfill.
