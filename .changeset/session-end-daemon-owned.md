---
"@lossless-claude/lcm": patch
---

The SessionEnd hook hands the whole end-of-session sequence to the daemon in one acknowledged request (`POST /session-end`): ingest, then compact, promote, promote-events and session-complete run daemon-side after a `202`. The host's SessionEnd budget no longer cancels the hook mid-ingest and drops the steps after it. The redaction notice moves from the terminal to the hook error log.
