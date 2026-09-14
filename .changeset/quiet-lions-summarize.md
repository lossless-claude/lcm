---
"@lossless-claude/lcm": minor
---

feat: generate new summaries in the project's recorded language

Add `summarizer.language` for an explicit output language. When it is unset,
new summaries use the project's recorded author language when available;
existing captured messages and summaries are unchanged.
