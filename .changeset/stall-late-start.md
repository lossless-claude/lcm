---
"@lossless-claude/lcm": patch
---

Exclude requests and background tasks that start after a reported event-loop stall's end bound from `daemon.stalled` attribution.
