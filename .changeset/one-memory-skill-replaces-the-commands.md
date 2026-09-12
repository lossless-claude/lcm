---
"@lossless-claude/lcm": minor
---

feat: one `/memory` skill replaces the nine slash commands

`/memory <command> [options]` runs any CLI command after reading `lcm help <command>`, and
shows the output verbatim. It replaces `/lcm-compact`, `/lcm-curate`, `/lcm-diagnose`,
`/lcm-doctor`, `/lcm-import`, `/lcm-promote`, `/lcm-sensitive`, `/lcm-stats` and
`/lcm-status`, each of which only ran the command of the same name. `lcm install` installs
the skill to `~/.claude/skills/memory/` and removes the command files earlier versions left in
`~/.claude/commands/`.

Removed with them, for lack of use: the `lcm-context` skill (the MCP tool descriptions say
when to use each tool) and the four agents `compaction-reviewer`, `health-investigator`,
`memory-explorer` and `transcript-debugger`.
