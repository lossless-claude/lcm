---
"@lossless-claude/lcm": patch
---

Bound doctor cwd checks with asynchronous stats, per-path deadlines and limited concurrency. Report timed-out and unattempted cwds as unchecked instead of missing, and continue reporting other doctor checks.
