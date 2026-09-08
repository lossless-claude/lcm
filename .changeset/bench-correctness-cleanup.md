---
"@lossless-claude/lcm": patch
---

Four correctness fixes in `lcm bench`, all confirmed by the review panel on #361. Repeated-prompt detection now compares prompts trimmed, so the same text with a trailing newline in another session no longer slips through as unique evidence, and the grouping is bounded to prompt-sized rows instead of loading every repeated paste in the corpus. Session labels are matched trimmed, so a hand-curated `sessionId` with a stray space scores its hit instead of silently missing. A benchmark file that exists but does not parse now reports the parse error rather than "No benchmark file", whose advice — run `bench build` — would have overwritten the file being fixed.
