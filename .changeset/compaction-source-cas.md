---
"@lossless-claude/lcm": patch
---

Publish a compaction pass only if its source range is unchanged. A pass whose chunk another writer replaced or cleared while the model ran (a worker purge, or any writer that skips the session's compaction guard) is now discarded before its summary, links or search row are written, instead of leaving an orphan, searchable summary behind a foreign-key failure. The run stops without a retry and keeps earlier passes; `/compact` logs `compact.source_changed` and answers `skipped`, or `partial` when earlier passes were published, rather than 500, so replay retries the session. Adds a read-only context coverage query that counts how often each message is covered, and tests that pin the invariant across yielded summaries.
