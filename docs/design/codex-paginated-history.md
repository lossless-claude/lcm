# Codex paginated history

## Confirmed upstream behaviour

At [Codex revision dd90f160](https://github.com/openai/codex/tree/dd90f160ed9bf91320c417335ddff848b6a23dd0):

- Closing a live history window **appends**, rather than rewrites, a `compacted`
  record carrying `window_number`, `previous_window_id` and replacement model
  context. `Session::replace_compacted_history` and `persist_rollout_items`
  ([session/mod.rs](https://github.com/openai/codex/blob/dd90f160ed9bf91320c417335ddff848b6a23dd0/codex-rs/core/src/session/mod.rs#L3983))
  reach `live_writer::durable_write`, then
  `RolloutWriterState::write_pending_items_once`; `open_log_file` opens for
  append ([recorder.rs](https://github.com/openai/codex/blob/dd90f160ed9bf91320c417335ddff848b6a23dd0/codex-rs/rollout/src/recorder.rs#L1748)).
  Ordinary compaction therefore does not trigger lcm's shorter-history guard.
- Legacy migration rewrites the rollout into paginated form:
  `LegacyRolloutCanonicalizer::write_head_session_meta` sets
  `history_mode: "paginated"`; subagent `select_bounded_context` retains a
  suffix beginning at a usable compaction, and
  `rewrite_subagent_history_boundary` records
  `subagent_history_start_ordinal`
  ([migration](https://github.com/openai/codex/tree/dd90f160ed9bf91320c417335ddff848b6a23dd0/codex-rs/thread-store/src/local/rollout_migration)).
  A rollout can consequently contain `session_meta`, a `compacted` checkpoint,
  then the subagent's own response items. Parent identity may be recorded by
  `forked_from_id` or `source.subagent.thread_spawn.parent_thread_id`.

Unconfirmed: this does not establish the cause of every root-session shortening,
nor behaviour in other Codex revisions. File timestamps alone prove no alignment.

## Recovery rule

The Codex transcript-source adapter validates project and session identity first.
Normal recovery still requires a stored prefix. If that fails, only a shorter,
nonempty paginated **subagent** rollout with a valid
`subagent_history_start_ordinal` can re-anchor: every parsed message must equal
the stored tail in role and normalized content under current redaction. This is
strict equality, without the legacy NUL-cut or removed-redaction wildcard
allowances. A root, an empty parse or a differing tail is not proof.

On proof, return an empty delta at the stored count and persist the new end-of-file
cursor in capture's existing transaction. Its message count remains the total
stored count, including the retained prefix. Stored messages and summaries are
never rewritten or deleted. Later appends resume from that cursor.

## Terminal state

A paginated recovery mismatch raises a terminal `TranscriptSourceError`.
Extend the existing `subagent-guard-failures.json` path with a Codex terminal
entry keyed by session identity and tied to the project database identity.
Ingest skips it before reading the transcript, including after restart and file
growth; doctor reports the retained reason and path. It is not session completion.
The existing Claude unchanged-file guard and repair behaviour remain intact.
Each terminal entry records the recovery-rule version from
`CODEX_RECOVERY_RULE_VERSION` in `src/transcript-source.ts`. Bump it when changing
which histories recovery can align: the next capture (scan or import included)
clears an older entry and retries once. Legacy entries without a rule version are
older. An unrelated package upgrade retains guards.

`lcm import --provider codex --retry-blocked` clears terminal Codex guards in the
current project. Add `--session <id>` to clear only that session, or `--all` to
clear guards in every project with a project record. It requires `--provider codex`
and rejects `--replay`, `--rebuild`, `--dry-run`, and `--all` with `--session`.
Doctor names the command. `/capture-retry` performs this under the project queue
and mutation lease, preserving messages, summaries, cursors and Claude guards.
The next capture rechecks alignment under current redaction rules. An unprovable
history is blocked again and recorded once; NUL-cut repair cannot establish a
missing alignment.

## New captures and inherited history

Recommend storing only a paginated subagent's own ordinal range, without
reconstructing inherited parent history. This avoids duplicate storage and
compaction; its cost is dependence on the parent's separate capture for context.
Defer that filter: lcm's byte reader currently counts parsed messages, while
Codex's boundary counts all rollout records, including non-message checkpoints.
Reliable filtering needs ordinal-aware parsing shared by live capture, import
and repair, plus a policy for missing or malformed boundaries. This patch keeps
messages explicitly present in the rollout, never expands inherited references,
and retains any inherited rows already stored.
