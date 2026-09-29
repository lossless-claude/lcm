---
"@lossless-claude/lcm": patch
---

Route replay restart resets through the daemon's session compaction guard, project queue and mutation lease so an in-flight summary cannot outlive the reset.
