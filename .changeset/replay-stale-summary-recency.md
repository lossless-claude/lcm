---
"@lossless-claude/lcm": patch
---

Replay hardening follow-ups (#330)

- A timed-out `/compact` now only recovers a summary persisted after the call
  started: a stale summary from an earlier run or hook is no longer recorded
  as the session's result and spliced into the chain.
- A mid-flight socket drop (ECONNRESET) is treated like a timeout — the run
  re-reads the persisted summary instead of breaking the chain.
- When the recovery path finds the summary was stored, the run summary counts
  its tokens so the reported totals agree with the ledger.
- `import --replay --restart` with `provider all` now refuses up front when
  the daemon is still compacting any project the import will touch, instead of
  wiping earlier lists and then throwing on a later one.
