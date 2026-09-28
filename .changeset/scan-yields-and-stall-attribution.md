---
"@lossless-claude/lcm": patch
---

The periodic transcript scan (every 10 minutes) no longer walks every project directory synchronously: it reads directories with `fs/promises` and yields to the event loop every 50 projects, so a store with tens of thousands of projects no longer blocks the daemon for seconds at a time. The scan and the ingest behind `/session-end` are now named in `daemon.stalled` records (`scan:transcripts`, `session-end:ingest`) when a stall happens during either, instead of blaming whatever HTTP request happened to be in flight. `GET /summarize-jobs/next`, a long poll that is always in flight by design, is no longer named as a cause of a stall; `daemon.stalled` now carries a `longPollCount` field instead of one record per pending long poll.
