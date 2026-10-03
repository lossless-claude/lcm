---
"@lossless-claude/lcm": patch
---

Preserve operator holds on daemon restart unless `--release-hold` is explicit.
Check the offline hold before stale-store cleanup lists projects and throughout
its moves; stop and report recoverable moved paths if the hold is lost.
