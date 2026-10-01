---
"@lossless-claude/lcm": patch
---

Remove the unused hard-trigger compaction setting and use the shared fanout defaults of 3 and 2 for invalid values instead of the stale 8 and 4 fallbacks. Clarify expansion token-cap support and the uncapped daemon path.
