---
"@lossless-claude/lcm": patch
---

Skip a subagent transcript on each parent `/ingest` when its capture would read and write nothing: the stored cursor is one the reader would resume from, it sits at the end of the unchanged file, and no attribution waits to be stored. A session with hundreds of subagents no longer pays a full capture for each of them on every ingest. The daemon log gains `ingest.timing` (queue, capture, discovery and subagent time, with how many subagents were skipped, captured or failed) and `request.aborted` for an `/ingest` whose client left before the answer.
