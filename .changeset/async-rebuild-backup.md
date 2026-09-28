---
"@lossless-claude/lcm": patch
---

Back up project databases in short asynchronous steps before rebuilding Claude Code sessions, keeping the daemon responsive during large backups on Node versions that support `node:sqlite` backup.
