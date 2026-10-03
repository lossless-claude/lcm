---
"@lossless-claude/lcm": patch
---

Bound daemon health probes by the caller's remaining lifecycle budget so busy daemons can still serve hooks, while non-answering listeners cannot hold hooks open or trigger replacement spawns. Give CLI clients a 10-second lifecycle budget and standalone health checks a bounded 5-second default. Keep connect-only and unawaited module health probes at 500 ms. Include shutdown probes in the stop budget and never report a non-answering listener as stopped. Report the stuck listener once per session, allow 10 seconds for function-hook restore and 5 seconds for other POSTs, and reserve lifecycle time inside PreCompact's host timeout.
