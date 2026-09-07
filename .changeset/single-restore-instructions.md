---
"@lossless-claude/lcm": patch
---

Avoid duplicate CLAUDE.md instructions on startup, resume, and clear while preserving post-compaction replay. Include files reached through multiple paths only once in the saved snapshot.
