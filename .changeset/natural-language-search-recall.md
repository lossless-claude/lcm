---
"@lossless-claude/lcm": minor
---

Fix `lcm search` returning empty for natural-language questions (0/20 recall in the reporter's corpus, worse than plain `grep`). Queries are now prepared before reaching FTS5: stopwords are dropped, the remaining content terms are tried as AND first, then as a BM25-ranked OR, then as a substring LIKE scan when the question's vocabulary does not overlap the corpus at all. `/search` layer failures are now logged and surfaced in the response (`errors` key) instead of being silently indistinguishable from "nothing matched".

Adds the recall benchmark from the issue: committed synthetic fixtures with a CI gate (`recall@5 ≥ 0.60`, strictly beats the grep baseline, empty-rate ≤ 10%, p95 ≤ 500 ms) plus `lcm bench build|run`, which builds and runs a natural-language benchmark against your own ingested sessions (local only, never committed).
