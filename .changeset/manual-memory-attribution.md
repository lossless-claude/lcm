---
"@lossless-claude/lcm": patch
---

Add preview-first manual memory session attribution repair to `lcm doctor`. Match
raw Claude and Codex store calls, leave ambiguous and unmatched memories alone,
and require explicit offline apply with a database backup to update only session ids.
