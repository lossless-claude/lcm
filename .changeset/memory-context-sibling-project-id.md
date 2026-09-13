---
"@lossless-claude/lcm": patch
---

fix: the `<memory-context>` block names a sibling checkout's memories with their project

Promoted memory is unioned across every checkout of a repository, so the `<memory-context>` block
a prompt receives could surface a memory from a sibling checkout. Its id, listed bare in the
trailing `surfaced-memory-ids` comment, then resolved against the current project and answered
"not found" when passed to `lcm_describe` or `lcm_expand`. An id from a sibling now renders as
`<id>@<projectId>`, and the block's intro sentence tells the agent to pass that suffix as
`projectId`. An id from the current project keeps its bare form.
