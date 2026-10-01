---
"@lossless-claude/lcm": patch
---

Skip transcript scan requests for vanished working directories and report skipped sessions in one debug entry per scan. Capture resumes when the directory returns.

Skip Codex and OMP sessions with missing working directories before import or replay sends requests to the daemon. Check each distinct cwd once per import run and report skipped sessions in one `Skipped (cwd missing): N` summary line. Keep daemon cwd validation unchanged.
