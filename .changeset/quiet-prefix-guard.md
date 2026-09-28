---
"@lossless-claude/lcm": patch
---

Memoize validated Claude transcript prefixes so compacted sessions compare only newly stored overlap while unchanged prefix fingerprints still match. Revalidate after identity, history, or redaction changes, and retain the rebuild error for damaged sessions. `daemon.stalled` no longer names a request or background task that ended before the block began, and names the tool-call model backfill `/ingest` runs after replying as `ingest:backfill`.
