---
"@lossless-claude/lcm": patch
---

Ranked full-text search over messages and summaries orders by `rank` alone in SQL, so FTS5 applies the candidate limit itself and the source row and snippet are read only for the candidates kept; before, every matched row was joined and snippeted before the limit, and a many-term query on a large corpus took seconds. Newer matches still break relevance ties, now among the kept candidates, so which equal-rank rows sit at the limit boundary may differ.
