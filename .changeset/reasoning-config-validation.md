---
"@lossless-claude/lcm": patch
---

Reject a non-object `llm.reasoning` at config load instead of forwarding it verbatim to the provider, where it surfaced as an opaque HTTP error inside the unattended `/compact` route. The OpenAI summarizer now keys the parameter off `!== undefined` rather than truthiness, so a caller that passes it programmatically is no longer second-guessed.
