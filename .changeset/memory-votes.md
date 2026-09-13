---
"@lossless-claude/lcm": minor
---

feat: agents can vote on a promoted memory; `lcm stats` surfaces promotion candidates and contested memories

`lcm_store` accepts a `signal:memory_vote` record: `vote:+1` ("checked against current evidence and still correct") or `vote:-1` ("checked and contradicted"), naming the target with `memory_id:<id>`, with a reason required in the text on both directions. A malformed vote — missing or duplicated `memory_id:`/`vote:` tags, an unrecognized vote value, or an empty reason — is rejected with a message naming the broken rule. The target may live in a sibling checkout of the same repository; the store resolves it the way `lcm_describe` resolves a `projectId` and writes the vote into whichever database holds it. A repeated identical vote from the same real session counts once; a later opposite vote from the same session archives the earlier one.

`lcm stats` and `lcm_stats` gain two sections, always shown when non-empty: **Promotion candidates** (memories with reported uses at or above the new `promotion.enforcementThreshold`, default 3, shown with their `+1`/`-1` counts) and **Contested** (any memory with at least one `-1`, with each objection's reason and vote id). A contested entry clears by archiving the memory, superseding it with a corrected `lcm_store`, or dismissing a single objection by archiving its own vote id through the existing `/review-stale` archive action. Recall is unchanged: votes affect no ranking, scoring, or prompt-time injection.

Fixes a gap this made visible: `signal:memory_used` and `signal:memory_vote` records were previously reachable through `lcm_search` and the prompt hook like any other promoted memory. Both are now excluded from every promoted-memory search — they exist to be counted, not surfaced.
