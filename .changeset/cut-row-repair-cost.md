---
"@lossless-claude/lcm": patch
---

Cut-row repair skips alignment when the transcript has no NUL, checks only NUL-bearing matches for repair, and avoids redaction scans when alignment can match exact or cut-prefix content.
