---
"@lossless-claude/lcm": patch
---

Named OpenAI and Anthropic endpoints can limit simultaneous HTTP summaries with `maxConcurrent`. Calls beyond the limit wait in daemon-wide FIFO order, with a separate bound for the slot wait and a fresh request deadline after admission.
