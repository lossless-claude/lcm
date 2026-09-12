---
"@lossless-claude/lcm": patch
---

fix(plugin): the `lcm-context` skill now loads; two stale files leave the plugin

The skill lived under `.claude-plugin/skills/`, which Claude Code does not scan, so
no plugin user ever saw `/lcm:lcm-context`. It now lives at `skills/lcm-context/`,
the location the plugin loader reads by default, and its recovery table names the
real command (`lcm daemon start --detach`).

Removed from the plugin: the `lossless-claude-upgrade` skill (a rebuild-from-source
recipe for developing lcm, which also never loaded) and `.claude-plugin/hooks/README.md`
(it listed four hooks where the plugin registers seven; `docs/hook-protocol.md` is
the reference).
