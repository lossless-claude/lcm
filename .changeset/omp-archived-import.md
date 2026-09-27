---
"@lossless-claude/lcm": patch
---

`lcm import --omp` now discovers and imports archived `.jsonl.gz` OMP sessions (written by `omp gc --apply`), alongside live `.jsonl` files. An archive is read in full on every import, with no resume checkpoint; a repeated import stays idempotent through the same already-stored check every source uses. When a live file and an archived copy exist for the same session id, the live file wins.
