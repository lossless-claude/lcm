---
"@lossless-claude/lcm": patch
---

The function-hooks module (`llm.provider: "session"`) no longer throws when the host answers a summarize job with a non-string `text`. `model.complete` and `model.fork` results are treated as unanswered in that case, with a reason naming the host call, instead of crashing with `text.trim is not a function`; usage from the failed attempt is still reported.
