---
"@lossless-claude/lcm": patch
---

A Claude Code session resumed after it ended (`claude --resume`) is captured again. Resuming appends to the same transcript file under the same session id, but once a session was recorded complete every later capture skipped it, so the turns after the resume were never stored. Capture and `lcm import` now skip a completed session only while its transcript has not been modified since it was completed, and ending the resumed session records the new completion time.
