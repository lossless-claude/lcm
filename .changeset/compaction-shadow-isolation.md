---
"@lossless-claude/lcm": patch
---

Isolate compaction shadow accounting from ordinary summaries, and refuse further shadow calls after unknown usage without triggering ordinary provider fallback. Prepare header inputs before publishing a cut so failed preparation leaves no pending artifact.
