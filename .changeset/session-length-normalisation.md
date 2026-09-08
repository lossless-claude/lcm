---
"@lossless-claude/lcm": minor
---

Rank sessions by relevance rather than by size. `lcm search` scored a session by the reciprocal rank of the best position any single one of its rows reached, so a long session — entering the candidate pool many times — landed a row high on almost any query and crowded out shorter, more relevant ones: measured, one 368 KB session took 11 of 13 top-5 slots on unrelated questions. Session scores are now damped by the session's message count, the way bm25 already damps a message by its length. Chosen on five corpora and graded once on four it had never seen, hit@5 moves 0.269 to 0.320 (+13 questions against −3, sign test p = 0.02), improving on every held-out corpus.
