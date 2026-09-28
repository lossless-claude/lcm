---
"@lossless-claude/lcm": patch
---

Claude session rebuild can repair conversations captured before role tagging when every stored message remains in the transcript. It compares their content across the current and older tool-content parser shapes regardless of role, then stores today's shape and parser stamp.
