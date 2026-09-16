---
"@lossless-claude/lcm": patch
---

`lcm stats` and `lcm_stats` show the share of conversations search excludes as subagent transcripts

Search drops subagent transcripts by a session-id naming convention (`agent-`) owned by the
host harness. The Memory section now reports how many stored conversations that rule matches,
over all conversations, and how many the `.meta.json` sidecar attributed to a parent session
without matching the rule — the count that turns non-zero when the convention drifts.
