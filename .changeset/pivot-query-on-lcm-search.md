---
"@lossless-claude/lcm": minor
---

feat: `lcm_search` takes a `pivotQuery`, the caller's own translation of the query

A project's author may write in one language while most of the text that answers
a query — tool output, code, summaries — is in another. `lcm_search` now accepts
an optional `pivotQuery`: the caller's translation of `query` into
`search.pivotLanguage` (new, default `en`). Each side is prepared on its own, so
each loses only its own language's function words, and the two term sets are
searched together — a hit through either side counts. Without a `pivotQuery`, or
with one that adds no term, search behaves exactly as before.

The caller is told when to supply one: the `lcm_search` description names the
project's author language and the pivot language when they differ, a search
response carries both once a language has been recorded for the project, and the
`<memory-context>` block the prompt hook emits carries the same one-line hint.
No model call is added inside the daemon at query time, and `lcm_grep` keeps its
literal semantics.
