---
"@lossless-claude/lcm": patch
---

Bound daemon health probes and lifecycle startup so a non-answering listener cannot hold hooks open or trigger replacement spawns. Report the stuck listener once per session, bound function-hook HTTP waits, and reserve lifecycle time inside PreCompact's host timeout.
