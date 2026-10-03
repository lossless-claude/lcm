---
"@lossless-claude/lcm": patch
---

Prune the function-hooks module's per-session output budgets when a session ends, so a long-lived host that goes through many sessions no longer keeps one entry per session id. An entry with a lease still pending is removed when its last lease settles, and work that already holds a budget keeps spending on it.
