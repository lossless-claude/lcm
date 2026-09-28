---
"@lossless-claude/lcm": patch
---

Persist successful transcript scan fingerprints in each project's sidecar so daemon restarts skip unchanged transcripts. Yield between transcripts within one project to keep the daemon responsive during large scans.
