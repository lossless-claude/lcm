---
"@lossless-claude/lcm": patch
---

A summary cut off at the output cap (`finish_reason: "length"`, or Anthropic's `stop_reason: "max_tokens"`) is now asked for once more on the same endpoint before the chain moves on: with the shorter summary prompt and twice the output cap. Before, the next endpoint got the same request, so a chunk every endpoint cut off failed the compaction on every run. The cut-off answer is still never stored and still counts as a failed call.
