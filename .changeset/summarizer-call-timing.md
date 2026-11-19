---
"@lossless-claude/lcm": patch
---

Log one `summarizer.call` record per `claude-process` summary call during compaction, failed and timed-out calls included, with the wall time from spawn to exit and the CLI's reported duration, API duration, and input, output and thinking tokens.
