---
"@lossless-claude/lcm": patch
---

Report missing temporary or test project stores and orphan summaries in doctor. Add a dry-run-first, explicit cleanup that moves stale stores and event sidecars to lcm's trash and removes their group-index references while the daemon is held offline. Guard test home resolution against the OS user's real lcm home, including child processes and symlink aliases.
