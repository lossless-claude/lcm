---
"@lossless-claude/lcm": patch
---

Removed `compaction.leafTokens` and `compaction.maxDepth`, which nothing read. Tuning them changed nothing, which made them a trap. A config file that still sets them keeps loading; the values are ignored as before. `compaction.autoCompactMinTokens` stays: `lcm compact` uses it as the token threshold that picks which conversations to compact.
