---
"@lossless-claude/lcm": patch
---

Report function-hook snapshot write failures only when the host write fails, including failures after the bounded wait. Slow successful writes no longer report a failure.
