---
"@lossless-claude/lcm": patch
---

Leaf and condensed summaries now see the preceding chunk's summary. The compaction engine always passed it, but `SummarizeContext` had no field for it and no provider rendered it, so `<previous_context>` was always `(none)` on the daemon path and `/compact`'s `previous_summary` was accepted and ignored.
