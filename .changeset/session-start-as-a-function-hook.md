---
"@lossless-claude/lcm": patch
---

The function-hooks module now restores the session's memory itself, through a `prompt.context` block named `lcm`, instead of leaving it to the `SessionStart` command hook. The hook's other half — pruning the events sidecar and promoting what an earlier session left behind — moved to the daemon's new `POST /session-scavenge`, which the module fires without waiting; the command hook awaited it with the session blocked behind it. `lcm restore` stays in place for sessions without the module, and stands down when the module has claimed the session.

The mark that tells a post-compaction restore from a fresh one now lives in the project database (`session_compactions`) instead of daemon memory, so a daemon restart inside the 30-second window no longer makes a restore replay the wrong content. `prompt.context` carries no reason for firing, which makes that mark the only signal the module has.
