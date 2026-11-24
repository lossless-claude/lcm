---
"@lossless-claude/lcm": minor
---

Add `compaction.liveLeafTrigger` (default off). When set, a hook ingest that leaves a live session with a leaf chunk of raw backlog sends the daemon an unforced background `/compact` for it, so PreCompact finds about one chunk to summarize instead of a whole context window. The transcript scan and SessionEnd never fire it, and a session whose run failed is left alone for 10 minutes. `/compact` accepts `force: false`. A PreCompact that finds such a run in flight captures first, then waits for it only when the run's estimated remainder and one more call fit the reply budget, and otherwise answers 202 at once.
