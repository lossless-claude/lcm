---
"@lossless-claude/lcm": minor
---

Add an opt-in incremental project timeline with immutable digest and period nodes,
exact session coverage and attributed manual-memory claims. Enable installs tracking
and detach triggers atomically; ordinary stores have no timeline triggers. Disable
retains tracking, while teardown removes dependent references before triggers.
`lcm timeline teardown --remove-nodes` also removes all owner summaries and
node rows safely, keeping session summaries and messages intact.
Migration restores missing tracking and detach triggers and replaces outdated SQL
on tracked stores; doctor reports gaps read-only and names the repair command.
Already-current migration reads before writing and completes on read-only stores
or behind another connection's writer when no repairs or archival are needed.

Persist metadata-only session items and month-local plans. Validate publication
against the unit's own session counters and memory hashes in one lease, without
replanning. Add default-off `timeline.generationEnabled`, quiet-period debounce,
ordinary ticks that drain persisted work once generation is on, and persisted
model-failure/publication-conflict backoff. Remove the replay completion trigger
and unused drain flag so ledger inserts perform no timeline manifest scan. Only bounded
named HTTP endpoints and their admitted fallbacks serve timeline generation.
Admission failures return a configuration 4xx before database work, printed verbatim
by the CLI, without model failure flags, backoff or parking. Require at least one
endpoint without missing environment variables. The first admitted generation
settle releases legacy backed-off and parked units once; legacy model failures
also receive one retry because failure causes were not recorded. A conflicted session
stays dirty for the next pass while other sessions and independent units continue;
report conflict only when nothing else could proceed.

Keep status and doctor read-only, reporting dirty sessions as well as pending and
stale nodes. Print unavailable ordinary counts clearly and use table counts minus
indexed owner counts. Ignore timeline consumers in orphan checks and exclude the
owner from manual attribution. Explicit full reconciliation repairs tracking and checks conservative
conversation aggregates. Preserve read-only access to unmigrated stores. Row locators
and stable chunk boundaries are deferred: v1 tracks session dirt and permits repacking
within one month. Expansion behavior is unchanged.

A downgraded lcm promotes timeline nodes at every session end unless the nodes
were removed first with `lcm timeline teardown --remove-nodes`. Teardown without
the flag keeps those nodes. Re-upgrading archives those memories, matching
`source_summary_id` against owner summaries or the reserved
`session_id = 'lcm:project-timeline'`; such memories are never legitimate.
