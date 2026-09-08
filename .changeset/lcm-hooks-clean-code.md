---
"@lossless-claude/lcm": patch
---

Refactored `hooks/lcm-hooks.ts` for readability, with no behaviour change: the 78-line registration body became one function per hook, the 65-line summarize poller split into fetching, classifying and serving, timings and the "command not found" exit code became named constants, and the config parse no longer swallows its error. The daemon's "no such route" log now names the route in every case.
