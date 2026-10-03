---
"@lossless-claude/lcm": patch
---

Capture now scrubs skill and slash-command arguments before storing them in `message_parts`, and counts their matches with the message's. A secret passed as an argument was redacted from the stored message but kept in plaintext in the part beside it. Rows captured before this release are not rewritten.
