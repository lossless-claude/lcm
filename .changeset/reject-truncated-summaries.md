---
"@lossless-claude/lcm": patch
---

A summary the model did not finish is no longer stored. An `openai` response that stopped at `finish_reason: "length"`, an `anthropic` response that stopped at `stop_reason: "max_tokens"`, and any provider's answer holding only whitespace are rejected: the compaction pass fails with `compact.failed` naming the rejection, stores nothing and leaves context unchanged, and a replay retries the session on its next run instead of recording it as compacted. A rejected answer is never replaced by the truncated-source fallback. A length stop is not retried against the same endpoint. The rejected call's tokens are still counted in `llm_usage_stats`, as a failed call, and a session answer that was rejected, or abandoned for `llm.fallbackProvider`, is counted as failed rather than sharing the fallback's success.
