---
"@lossless-claude/lcm": patch
---

Correct the `authHeaders` doc comment in the session-end hook, which had its key phrase replaced by a redaction placeholder, and assert the mocked token directly in the session-end tests instead of deriving it by calling `readAuthToken`.
