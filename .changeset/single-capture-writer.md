---
"@lossless-claude/lcm": patch
---

fix: `/compact` captures transcript messages through the same module as `/ingest`

A session whose first messages reached the database through `/compact` had no
`message_parts` rows and, for a subagent transcript, no attribution on its
conversation. One capture module (`src/capture.ts`) now owns writing a
session's new messages for every route, including reading a subagent
transcript's sidecar when the caller supplies no attribution.
