---
"@lossless-claude/lcm": minor
---

Make `lcm import --replay` and `lcm compact --replay` resumable. Each run freezes its ordered session list in a per-project `replay_manifest` and records completed compactions in a `replay_ledger` (written only after the summary is persisted). A restarted run skips sessions whose content fingerprint still matches, restores the threaded summary chain from the last good row, and continues where the previous run stopped. Use `--restart` to discard recorded progress (and ledger-recorded summaries) and start from scratch. SIGINT/SIGTERM now wait for the in-flight compaction to settle before exiting, so a resumed run never duplicates or skips a half-finished session.
