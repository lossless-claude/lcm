---
"@lossless-claude/lcm": patch
---

Preserve transcript event timestamps separately from capture time across Claude Code, Codex and OMP capture, import and rebuild. Add resumable `lcm import --backfill-event-times` repair, recompute summary and conversation source bounds, and place timeline periods by event time with explicit capture-time fallback metadata.
