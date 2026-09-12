---
"@lossless-claude/lcm": patch
---

fix: subagent transcripts keep their parent session, type, and description

Subagent conversations imported from `~/.claude/projects/<session>/subagents/` now carry
`parent_session_id`, `subagent_type`, and `subagent_desc`, read from each transcript's
`.meta.json` sidecar. A one-time migration backfills these for subagent conversations
already ingested, matching against transcripts still present on disk.
