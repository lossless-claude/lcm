---
"@lossless-claude/lcm": patch
---

Make `lcm bench build --generator llm` produce recall questions instead of keyword lookups. Told only to "paraphrase", the generator returned the prompt's own vocabulary in a new sentence order: over 59 generated questions the mean share of question terms also present in their own prompt was 0.55, against 0.11 for the hand-written reviewed set, and search scored that easier set 0.75 where it scores the hand-written one 0.39. The generator is now handed the source prompt's distinctive words as words to avoid, and a generated question that still reuses more than half of them is rejected. On the same corpus that yields 60 questions whose overlap profile (mean 0.11, median 0.08) and difficulty (search 0.35) match the hand-written set — a benchmark large enough to tell a ranking change from noise.
