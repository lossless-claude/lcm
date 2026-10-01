---
"@lossless-claude/lcm": minor
---

Add an opt-in incremental project timeline with immutable digest and period nodes,
exact session coverage and attributed manual-memory claims. Enable installs tracking
and detach triggers atomically; ordinary stores have no timeline triggers. Disable
retains tracking, while teardown removes dependent references before triggers.
Migration restores missing tracking and detach triggers and replaces outdated SQL
on tracked stores; doctor reports gaps read-only and names the repair command.

Persist metadata-only session items and month-local plans. Validate publication
against the unit's own session counters and memory hashes in one lease, without
replanning. Add default-off `timeline.generationEnabled`, quiet-period debounce,
ordinary ticks that drain persisted work once generation is on, and persisted
model-failure/publication-conflict backoff. Remove the replay completion trigger
and unused drain flag so ledger inserts perform no timeline manifest scan. Only bounded
named HTTP endpoints and their admitted fallbacks serve timeline generation.
Admission failures return a configuration 4xx before database work, printed verbatim
by the CLI, without model failure flags, backoff or parking. A conflicted session
stays dirty for the next pass while other sessions and independent units continue;
report conflict only when nothing else could proceed.

Keep status and doctor read-only, reporting dirty sessions as well as pending and
stale nodes. Explicit full reconciliation repairs tracking and checks conservative
conversation aggregates. Preserve read-only access to unmigrated stores. Row locators
and stable chunk boundaries are deferred: v1 tracks session dirt and permits repacking
within one month. Expansion behavior is unchanged.

Older versions may enumerate and promote the synthetic owner; avoid promotion on
stores containing timeline nodes while downgraded.
