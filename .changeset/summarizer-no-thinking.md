---
"@lossless-claude/lcm": patch
---

The `claude-process` summarizer no longer inherits extended thinking or the user's `CLAUDE_EFFORT` from the daemon's environment: it runs with `MAX_THINKING_TOKENS=0`, which removes the hidden thinking phase from every summary call.
