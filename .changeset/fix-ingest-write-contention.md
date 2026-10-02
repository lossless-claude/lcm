---
"@lossless-claude/lcm": patch
---

Wait for concurrent project writes during capture and event-time backfill. Reserve migration write locks before reading, install the SQLite busy timeout before connection setup, and configure every writable project handle consistently.
