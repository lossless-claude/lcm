---
"@lossless-claude/lcm": patch
---

Persist the summarizer's reported cost. `llm_usage_stats` gains a nullable `cost_usd_total` and a `calls_with_cost` counter, so the dollars the providers already report are no longer dropped between `onUsage` and the database. An absent cost stays NULL and prints as `unknown` rather than `$0.00`, and a partially priced run is reported as "N of M calls priced" so it cannot pass for the full cost. Sub-cent charges print with six decimals.
