---
"@lossless-claude/lcm": patch
---

Skip Claude Code import candidates whose working directory is missing before capture or replay, and include them in the shared missing-cwd skip count. Other filesystem errors still reach the daemon.
