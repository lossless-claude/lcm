---
"@lossless-claude/lcm": patch
---

Capture Claude transcripts incrementally with durable byte cursors and stored-prefix validation, including across daemon restarts. Persist tool-call model metadata with each delta so backfill no longer scans the full transcript. Preserve parser-shape, rebuild, redaction and partial-record safeguards.
