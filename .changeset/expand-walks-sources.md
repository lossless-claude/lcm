---
"@lossless-claude/lcm": patch
---

`lcm_expand` on a condensed summary now descends into the summaries it was condensed from. It used to follow the edge the other way, returning the summaries that had consumed it — usually none for a top-level summary — so expanding a condensed summary showed nothing beneath it.
