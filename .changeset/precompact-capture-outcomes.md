---
"@lossless-claude/lcm": patch
---

Claude Code and Codex PreCompact hooks now have the daemon attempt transcript capture before lcm summarization. OMP retains its bounded capture request and submits lcm summarization only after Capture is confirmed. A failed or unconfirmed capture skips only lcm's summary while native compaction continues. The Stop hook keeps its retry timer eligible after an HTTP rejection. Active hook paths retain bounded operation counts and failure codes that `lcm doctor -v` can inspect without requiring the daemon to be running. The Claude Code function module accepts the current host model-result shape and accounts for usage from unanswered attempts before fallback.
