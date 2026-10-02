---
"@lossless-claude/lcm": patch
---

Avoid repeated git reads during commit backfill by scanning trailer history once per session and URL per run and reusing the initial refresh of stored references.
