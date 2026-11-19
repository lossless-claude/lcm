---
"@lossless-claude/lcm": minor
---

Add `compaction.liveLeafTrigger` (default off). When set, an ingest that leaves a live session with a leaf chunk of raw backlog sends the daemon an unforced background `/compact` for it, so PreCompact finds about one chunk to summarize instead of a whole context window. `/compact` accepts `force: false`, and a PreCompact with a reply budget waits out such an incremental run while the budget leaves room for one more call, then summarizes the residual.
