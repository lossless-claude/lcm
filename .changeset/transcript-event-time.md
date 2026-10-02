---
"@lossless-claude/lcm": patch
---

Preserve transcript event timestamps separately from capture time across Claude Code, Codex and OMP capture, import and rebuild. Add resumable `lcm import --backfill-event-times` repair, recompute summary and explicitly requested conversation source bounds, and place timeline periods by event time with explicit capture-time fallback metadata. Keep conversation reads free of message scans, page repairs through sequence and depth/id indexes, and preserve read-only rebuild previews on unmigrated stores. Automatic ticks resume tracked timeline bootstrap in bounded pages after an upgrade.

The timeline prompt revision makes every active tracked timeline node stale. The first settle after upgrade replans the timeline; generation regenerates those nodes with model calls within the requested call budget (or one unit per automatic tick). Metadata-only settles make no model calls.
