---
"@lossless-claude/lcm": patch
---

Count only scorable sessions when `lcm bench build` detects repeated prompts. The uniqueness pass grouped over every conversation while sampling draws only from conversations with a nonempty session id, so a prompt held once by a real session and once by a session-less conversation counted as two and was excluded — though it is unique among the sessions a question can be scored against.
