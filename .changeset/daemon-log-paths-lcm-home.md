---
"@lossless-claude/lcm": patch
---

When `lcm daemon start` or `lcm daemon restart` cannot reach the daemon, the message now points at `daemon.log` and `daemon.stderr` under the daemon's own home (`LCM_HOME`) instead of always naming `~/.lossless-claude/logs`.
