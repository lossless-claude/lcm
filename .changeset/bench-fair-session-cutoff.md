---
"@lossless-claude/lcm": patch
---

Cut both `lcm bench` columns at the same point. The score is over sessions but search ranks rows, so asking for `k` rows and then deduplicating by session surfaced 3.3 sessions per query on a real 105-session corpus instead of `k` — several rows of one session ate the budget — while the ripgrep baseline walks its hits until it has `k` distinct sessions and always fills them. The comparison handed grep more chances than search on the same question. Search now gets a row budget that fills every slot; the reported hit rates are unchanged on both local benchmarks, so this removes a confound rather than moving a number.
