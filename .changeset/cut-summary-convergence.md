---
"@lossless-claude/lcm": patch
---

Recover from repeatedly cut summaries by halving chunks at source boundaries and using deterministic source truncation for a single message. Preserve raw sources for expansion, bound split calls by the source count, and log content-free cut diagnostics including tail repetition.
