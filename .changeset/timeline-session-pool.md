---
"@lossless-claude/lcm": patch
---

Prioritize worker-pool jobs as live compaction, replay/background, then timeline, preserving FIFO within each class and existing deadlines. Allow project timeline generation through session-pool when every fallback also enforces this order.

Treat unclaimed timeline pool jobs as busy without failure flags, backoff or parking; claimed completion timeouts still count as model failures.
