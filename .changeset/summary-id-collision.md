---
"@lossless-claude/lcm": patch
---

Give every summary a unique id. Two summaries with identical text created in the same millisecond used to get the same id, and the compaction failed with `UNIQUE constraint failed: summaries.summary_id`.
