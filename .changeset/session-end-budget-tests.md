---
"@lossless-claude/lcm": patch
---

Make SessionEnd HTTP regression tests assert deadline cancellation and request ordering without relying on idle-machine elapsed times. Clarify that the hook budget uses timer deadlines.
