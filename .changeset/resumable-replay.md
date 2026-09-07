---
"@lossless-claude/lcm": minor
---

Make `lcm import --replay` and `lcm compact --replay` resumable. Each run freezes its ordered session list in a per-project `replay_manifest` and records completed compactions in a `replay_ledger` (written only after the summary is persisted). A restarted run skips sessions whose content fingerprint still matches, restores the threaded summary chain from the last good row, and continues where the previous run stopped. Use `--restart` to discard recorded progress and start from scratch: it removes **every** summary in the conversations the run touched, hook-written ones included, rebuilds their context from messages, and invalidates the other replay command's progress for those conversations. Run it with the daemon idle. SIGINT/SIGTERM now wait for the in-flight compaction to settle before exiting, so a resumed run never duplicates or skips a half-finished session; a second signal exits at once.
