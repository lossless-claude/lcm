---
"@lossless-claude/lcm": patch
---

Live `/ingest` now captures subagent transcripts nested under a workflow run
(`subagents/workflows/wf_<id>/`), as `lcm import` already did: one directory walker
serves import, live ingest and the migration backfill, which now also attributes
transcripts nested under a workflow run. A sidecar that is not a JSON object, or a
nested directory that cannot be read, no longer drops or aborts discovery.
