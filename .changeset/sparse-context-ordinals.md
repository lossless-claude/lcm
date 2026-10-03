---
"@lossless-claude/lcm": patch
---

Preserve gaps in context ordinals so compaction replaces only its selected range instead of renumbering the entire conversation. Keep context order, fresh-tail selection and incremental token totals correct with sparse ordinals, without migrating existing stores.
