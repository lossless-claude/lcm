---
"@lossless-claude/lcm": minor
---

The daemon writes a log. `~/.lossless-claude/logs/daemon.log` holds one JSON record per line: every request, each compaction's outcome or reason for skipping it, summarizer fallbacks, failed follow-up requests and route errors, all scrubbed of secrets. `daemon.logLevel`, `daemon.logMaxSizeMB` and `daemon.logRetentionDays` now take effect. Output from outside the log, such as a crash before it opens, goes to `logs/daemon.stderr`. `lcm doctor` has a `daemon-log` check that counts errors from the last 24 hours, and reports "coverage incomplete" instead of "0 errors" when the log cannot prove it holds every record.
