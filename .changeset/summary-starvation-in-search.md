---
"@lossless-claude/lcm": patch
---

Stop search from hiding summaries. Session fusion emitted one message per matching session before reaching any summary, so whenever the number of matching sessions reached the result limit no summary could surface at all — however well it scored. Summaries now draw first against a reserved third of the limit, messages take the rest, and whichever side underfills hands its leftover to the other.
