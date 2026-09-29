---
"@lossless-claude/lcm": patch
---

Compaction yields its project queue turn during external model calls, allowing captures of the same project to finish while a summary is in progress. Database mutation remains serialized by the project lease. Another session's PreCompact can run while a summary waits on its model; an active queue turn, outstanding mutation lease, or compaction of the same session still makes it busy. Direct compactions of the same project session wait for the active request to finish; `skip_ingest` callers retain their busy/skip outcome.
