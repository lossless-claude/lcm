---
"@lossless-claude/lcm": patch
---

A summary cut off at the output cap (`finish_reason: "length"`, or Anthropic's `stop_reason: "max_tokens"`) is now asked for once more on the same endpoint before the chain moves on, with twice the output cap. A leaf summary also switches to the shorter prompt; condensed and task summaries keep theirs. Before, the next endpoint got the same request, so a chunk every endpoint cut off failed the compaction on every run. The cut-off answer is still never stored and still counts as a failed call.
