---
"@lossless-claude/lcm": patch
---

`lcm import --replay` and `lcm compact --replay` stop the run when the daemon becomes unreachable, instead of marking every remaining session failed and breaking each one's replay chain. This also covers a daemon that is alive but wedged: a mid-flight socket drop now gets a quick health probe before deciding — a healthy answer keeps today's behaviour (retry/skip that one session), no answer stops the run the same way a refused connection does. Nothing is recorded for the session in flight — no ledger row, no chain reset — so rerunning the same command resumes exactly where it stopped.
