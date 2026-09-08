---
"@lossless-claude/lcm": patch
---

Report what `lcm bench` actually measures. The `--json` report exposed a single-source hit rate under the name `searchRecall`, and `bench build` sampled any user prompt — including harness boilerplate and text repeated across sessions, neither of which a single source label can score: search can return a genuinely correct session and be counted as a miss. `build` now only samples prompts whose text occurs in exactly one session, questions take an optional `sessionIds` list whose every entry scores as a hit, and the report fields are `searchHitRate` and `grepHitRate` with `hit@k` in the human output.
