---
"@lossless-claude/lcm": patch
---

Index foreign key child columns used when deleting messages and summaries, so SQLite can check dependent rows without scanning their tables.
