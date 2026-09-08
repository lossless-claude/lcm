---
"@lossless-claude/lcm": patch
---

Passive-learning events extracted from a user prompt now dedup on `(session_id, sha256(prompt))`, so a session where both the command hook and the function-hooks module run records each prompt once. A prompt carries no id both paths can see — the command hook's stdin has `prompt_id`, the module's `prompt.submit` has only the text — which makes the content hash the only shared key. Events sidecar schema v5 adds the `prompt_hash` column and its index; rows written earlier have no hash and never dedup against.
