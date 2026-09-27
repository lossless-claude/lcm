---
"@lossless-claude/lcm": patch
---

`lcm import --replay` and `lcm compact --replay` stop the run when the daemon becomes unreachable, instead of marking every remaining session failed and breaking each one's replay chain. Nothing is recorded for the session in flight — no ledger row, no chain reset — so rerunning the same command resumes exactly where it stopped.
