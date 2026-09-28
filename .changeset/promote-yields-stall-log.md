---
"@lossless-claude/lcm": patch
---

The daemon keeps answering while `/promote` and `/promote-events` work through a large backlog: both yield to the event loop between items and hold the project's mutation lease, so two runs for one project no longer promote the same summaries or events twice. The daemon log records `daemon.stalled` after the event loop was blocked for more than 5 seconds, naming the requests that were in flight, and `request.start` at `debug`.
