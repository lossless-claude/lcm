---
"@lossless-claude/lcm": patch
---

Reject an LLM-generated benchmark question that reuses more than half its source prompt's vocabulary. A recall benchmark asks whether search finds a session from the words a user would reach for later, not from the words already in the transcript; told to "paraphrase", the generator returned near-copies instead. Over 59 generated questions the mean share of question terms also present in their own prompt was 0.55, against 0.11 for the hand-written reviewed set, and search scores those keyword lookups at 0.75 where it scores the hand-written set at 0.39. Mechanical questions are exempt — they lift a focus term from the prompt by construction and already carry a diagnostic-only warning.
