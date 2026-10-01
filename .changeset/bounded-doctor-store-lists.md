---
"@lossless-claude/lcm": patch
---

Bound doctor per-store lists and orphan-summary ids to 20 entries with remaining counts. Aggregate stores without usable project records and expose complete diagnostic lists through `lcm doctor --verbose`; cleanup previews retain every candidate and skipped store. Skip orphan relationship queries when a database has no summaries.
