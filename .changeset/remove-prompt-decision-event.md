---
"@lossless-claude/lcm": patch
---

User prompts no longer produce a `user_decision` event. It fired on English keywords such as "always" or "never", missed every decision on a non-English corpus, and still promoted what it matched into memory. Decisions answered through `AskUserQuestion` are still recorded. Store a lasting decision with `lcm_store` and a `type:decision` tag.
