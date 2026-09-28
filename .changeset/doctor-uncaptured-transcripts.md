---
"@lossless-claude/lcm": patch
---

`lcm doctor` reports Claude Code transcripts that lossless memory never stored (`claude-capture`, category `Capture`): for every project lcm tracks, and for the current directory's project, the number of transcripts whose session has no stored message and was not completed since the file last changed, the most recent one's path, and the fix, `lcm import --provider claude` in that project. It never reads a transcript, only its file status, and opens each project database read-only; it leaves out transcripts modified in the last 15 minutes, whose session may still be running. A session captured only in part is not reported.
