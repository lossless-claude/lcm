---
"@lossless-claude/lcm": minor
---

feat: SessionStart catches up conversations left uncompacted by a session that ended without `SessionEnd`

A session killed by a crashed terminal, a sleeping machine, or a daemon that
was down at exit kept its raw messages captured but never summarized — only a
manual `lcm compact --all` revisited it. Every SessionStart now fires one
non-blocking `POST /session-start-compact` request; the daemon selects
conversations of the same project with enough raw messages not covered by summaries,
excludes the session that is starting, conversations already compacting, and
conversations below `compaction.autoCompactMinTokens`, and requests
compaction for at most `compaction.autoCompactSessionStartMax` of them
(default 2), oldest first, so a larger backlog drains over several starts.
`hooks.disableAutoCompact` turns the sweep off. Session-start latency is
unaffected: the request is fire-and-forget, mirroring the one `SessionEnd`
already uses.
