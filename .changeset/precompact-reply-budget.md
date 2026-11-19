---
"@lossless-claude/lcm": patch
---

PreCompact no longer holds native compaction for the whole 115 s hook deadline when the summary cannot finish in time. The hook sends a reply budget; after Capture the daemon estimates the summary's model calls from the raw backlog and, when they cannot fit, answers 202 with a deferred summary and finishes compacting after the reply.
