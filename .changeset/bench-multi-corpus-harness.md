---
"@lossless-claude/lcm": patch
---

Add `scripts/bench-corpora.mts`, which scores `lcm bench` across several local project corpora and pools the result. A single benchmark cannot separate a ranking improvement from noise: two changes that read as clean wins on one 13-question set did not survive pooling over 221 questions from eight corpora, one of them turning negative and pushing p95 past the latency budget. Retrieval ranking changes are measured here from now on.
