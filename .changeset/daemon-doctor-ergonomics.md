---
"@lossless-claude/lcm": patch
---

Make `lcm daemon start` idempotent (reports an already-running daemon instead of crashing with EADDRINUSE), add `lcm daemon stop` and `lcm daemon restart`, expose a build fingerprint and pid in `/health` so a same-version rebuild is detected as stale, and make `lcm doctor` verify the lcm plugin is actually installed and enabled in Claude Code before reporting hooks as healthy. Event stats now scan the newest project DBs first and say when the scan was sampled.
