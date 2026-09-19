---
"@lossless-claude/lcm": patch
---

Removed `LCM_INCREMENTAL_MAX_DEPTH`, a documented environment variable that had no consumer: no code path ever read it into a decision, so setting it changed nothing.
