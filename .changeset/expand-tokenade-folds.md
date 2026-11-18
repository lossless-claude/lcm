---
"@lossless-claude/lcm": patch
---

Capture now stores the original of a Claude Code transcript row that tokenade folded before lcm first stored it, read from tokenade's stash, instead of the placeholder. A stashed file is used only when its bytes hash to the name the placeholder gives and it begins with the opening the fold kept, and a row only when every fold in it is restored and the restored row still matches the folded transcript row, so later captures verify it. A row that cannot be restored is stored as before and counted as kept in the ingest response (`tokenadeFolds`) and the daemon log.

`lcm import --provider claude --rebuild --expand-folds` previews, and with `--yes` restores in place, the stored rows and tool-call inputs a capture took as placeholders, after backing up the project database; a stored original is never replaced.
