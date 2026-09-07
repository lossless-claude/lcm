---
"@lossless-claude/lcm": patch
---

Reject a non-object `llm.reasoning` at config load instead of forwarding it verbatim to the provider, where it surfaced as an opaque HTTP error inside the unattended `/compact` route. A configured `reasoning` of `null` or `false` is now sent as written rather than silently dropped by a truthiness check.
