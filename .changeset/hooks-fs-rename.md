---
"@lossless-claude/lcm": patch
---

Follow Claude Code's `$.fs` rename in the function-hooks module: `readFile`, `writeFile`
and `listDir` became `read`, `write` and `list` in 2.1.267. The session claim had stopped
being written, so the command hooks stayed active alongside the module.
