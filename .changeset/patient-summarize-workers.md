---
"@lossless-claude/lcm": patch
---

Keep live summarize workers admitted after pool job expiry and restore valid abandoned bindings on polling. Release undelivered claims on failure, handle empty hook polls quietly, retry worker enrollment contention and delayed confirmation, and retry transient pool answer delivery without repeating completion. Permanent capture exclusion stays intact.
