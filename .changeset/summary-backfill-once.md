---
"@lossless-claude/lcm": patch
---

Summary depth and metadata backfills run once per database, and again when their columns are added, instead of recomputing summaries on every migration sweep. New summaries continue to receive these fields when inserted.
