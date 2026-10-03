---
"@lossless-claude/lcm": patch
---

Deduplicate tool-lesson pair evaluations, cache command shapes per refresh page,
and yield on a 10 ms work budget outside transactions while preserving resumable
journal and snapshot publication.
