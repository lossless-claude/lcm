---
"@lossless-claude/lcm": patch
---

Point the recall gate at the search path it claims to measure. It ranked sessions by concatenating `RetrievalEngine.grep` candidates by hand, skipping session fusion, the result limit and selection — the stages a caller actually receives — so a fusion bug passed it green in both directions. It now calls `searchNativeHistory`, and a new case covers the message/summary mix that session-level recall is blind to.
