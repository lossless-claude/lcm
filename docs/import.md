# Import past sessions

`lcm import` discovers and imports Claude Code, Codex, and Oh My Pi session transcripts for the current project. `--replay` adds threaded compaction of each imported session; it does not change which sources are read. Choose a source explicitly when needed:

```sh
lcm import --provider codex --dry-run
lcm import --provider omp --dry-run
lcm import --omp --dry-run
lcm import --replay --dry-run
lcm import --replay
lcm import --provider omp --replay
lcm import --omp --replay
lcm import --provider all --all --dry-run
```

`--provider` accepts `claude`, `codex`, `omp`, or `all`. The default is `all`. `--codex` is an alias for `--provider codex`, and `--omp` is an alias for `--provider omp`. This selects transcript sources, independently of the model used to summarize them. Without `--all`, only the current project is selected. With `--all`, Claude imports tracked projects, Codex imports all projects identified in its transcripts, and OMP imports all discovered sessions whose working directory identifies a project.

Codex discovery reads `~/.codex/sessions/` and `~/.codex/archived_sessions/` recursively, including dated `YYYY/MM/DD/rollout-*.jsonl` files and legacy layouts. It uses `session_meta.id` as session identity, falling back to the filename for older transcripts. If several files represent the same session, the latest modification time wins; an archive wins an equal-time tie. Discovery reads only the metadata header (up to 1 MiB), rather than loading every conversation. Files without a working directory in that header's `session_meta.cwd` are skipped rather than assigned to an unrelated project. Symlinks are not followed.

OMP discovery reads `<agentDir>/sessions/<encoded-cwd>/` for every `<agentDir>` a profile session could live under: the active one (`PI_CODING_AGENT_DIR` when set, else `~/.omp/agent`) plus `~/.omp/profiles/<name>/agent` for each named profile. The session id comes from the id in the session-file header, and the transcript file is selected through OMP's session manager. This includes archived `.jsonl.gz` sessions (`omp gc --apply` gzips a cold session in place); an archive is read in full on every import, with no resume checkpoint, and a repeated import stays idempotent through the same already-stored check as any other source. Each session id is imported from one file across all roots, because the id is the session's identity in memory: a live `.jsonl` always wins over an archived `.jsonl.gz` copy, otherwise the newest file wins, and an equal-time tie keeps the active root's copy before any profile's. Every file skipped in favour of another root's copy is listed in the result. `--provider omp`/`--omp` reports every root it scanned, so a "0 sessions" result names where discovery looked. Symlinks are not followed, including a profile whose `profiles`, `<name>` or `agent` directory is a symlink.

Codex and OMP sessions whose working directory no longer exists are skipped before capture or replay. Import checks each distinct cwd once per run, across both sources, and reports the skipped session count in one summary line: `Skipped (cwd missing): N`. It prints no per-session warning, including with `--verbose`. A later run checks the directories again, so a restored directory permits capture. A directory that exists but cannot be read is not skipped: its sessions are sent, and the daemon still rejects requests with an invalid cwd.

`--dry-run` lists the selected session count without starting the daemon, importing messages, or calling a model. Add `--verbose` for session identities. The count includes previously imported sessions and excludes Codex and OMP sessions whose cwd is missing; it describes selection, not new messages.

After successful compaction, `lcm import --replay` automatically promotes durable insights from summaries, once per project it compacted. Promotion is best-effort, as with `lcm compact`; a promotion failure does not undo the import. Use `--no-promote` to skip it. Import without `--replay` does not compact or promote, and `--dry-run` writes no promotions. If the daemon becomes unreachable during import, automatic promotion is skipped.

To catch up projects that already have summaries, use the existing promotion command; no replay is needed:

```sh
lcm promote --all --dry-run
lcm promote --all
lcm import --all --replay --no-promote
```

`lcm compact --replay` operates on conversations already stored in LCM, including Codex and OMP conversations. It does not scan transcript directories. Use `lcm import --replay` to discover historical files that LCM has not captured yet.

`--parallel N` with `--replay` processes at most N projects concurrently, preserving session order and the replay ledger within each project. `--replay-provider session-pool` selects dedicated interactive workers for replay alone. See [summarize workers](summarize-workers.md).

Codex and OMP import and live capture share a durable byte cursor. A repeated import reads only the appended suffix when its checkpoint is valid. OMP, like Codex, resumes from that cursor and does not take the already-ingested shortcut. File replacement, truncation, or growth after a previously imported final record without a newline requires a recovery scan. Cursor updates commit with message writes, so failed requests remain retryable without skipping or duplicating stored messages. An archived OMP `.jsonl.gz` session is the one exception: it is not append-only, so it carries no cursor and is re-read in full on every import; the already-stored check that every source uses keeps that idempotent.

A recovery scan must match the stored message prefix after current redaction rules are applied to both sides; a stored `[REDACTED]` span left by a pattern since removed or narrowed matches the text it replaced. If the file is shorter or its prior messages differ, capture fails without advancing the checkpoint, except for the proven paginated Codex rewrite below. An OMP session file is a tree whose abandoned branches stay in the file (see [Oh My Pi setup](omp.md#session-identity-and-transcript-layout)), so for OMP stored messages that are a prefix of the file's live path continue that path; otherwise they must appear in the file in order rather than as its prefix, and the scan adds the live-path messages that follow the last stored one. Restore the complete original transcript and compatible redaction rules before retrying; an unrelated replacement must not reuse the existing session's history. Bounded fingerprints detect changes in the first and last 4 KiB of the checkpointed prefix; rewrites confined to the unsampled middle remain outside the stable-prefix contract.

A shorter paginated Codex subagent rollout with parent identity and a valid `subagent_history_start_ordinal` can re-anchor when its nonempty parsed messages exactly equal the stored tail in role and normalized content under current redaction. This equality does not use removed-redaction wildcards or the legacy NUL-cut allowance. The cursor moves to the parsed end of the file with the total stored count; stored messages and summaries stay intact, and later appends can be captured. Every other paginated recovery mismatch becomes a terminal per-session guard: later capture requests skip reading the file, including after growth and restart, and `lcm doctor` reports the reason. Guards record the recovery-rule version: a rule change retries each older guard once on the next capture, including a scan or import; an unrelated upgrade keeps it. Clear terminal Codex guards in the current project with `lcm import --provider codex --retry-blocked`; add `--session <id>` to clear only that session, or `--all` to clear guards in every project with a project record. `--retry-blocked` requires `--provider codex` and cannot be combined with `--replay`, `--rebuild` or `--dry-run`, or with `--all` and `--session` together. The next capture rechecks alignment under current redaction rules without deleting messages or summaries; a remaining mismatch is blocked again and recorded once. Doctor names this command. NUL-cut rebuild does not repair these mismatches. New captures keep messages explicitly present in the rollout without reconstructing parent history; filtering inherited ordinal ranges is deferred. See [the design and Codex source evidence](design/codex-paginated-history.md).

`--replay` compacts selected sessions with context from earlier sessions in that project and source, resuming recorded progress on repeated runs. Replay context never crosses between projects or transcript sources. Codex imports and lifecycle hooks use the same session identity and ingestion path: repeated captures do not duplicate messages, while later transcript growth remains ingestible. User and assistant message text is extracted from Codex `response_item` records. A tool call becomes a `role: "tool"` message carrying only the tool's name (`arguments`/`input` are not stored), and a tool output becomes a `role: "tool"` message carrying its text. UI-projection event notifications are not imported, because they would duplicate the response items. OMP sessions use the session-file header identity and the same cursor-backed ingestion path for live capture and historical import. LCM's internal Codex summarizer runs without hooks and with ephemeral sessions, so its own work does not become future replay input.

## Rebuilding Claude Code sessions

Before compaction stopped counting its own event rows as captured transcript messages, the capture of a Claude Code session after a compaction skipped as many transcript messages as the session held event rows, and the first capture after the fix stored the session's last messages a second time. Such a session holds gaps and a repeated tail until it is rebuilt. Capture now verifies a compacted session's stored messages against its transcript first, and stops capturing it, writing nothing, when they are not the transcript's prefix; the error names the rebuild.

Claude capture also verifies the full stored prefix when its parser-shape stamp is absent or differs from the current parser. An aligned session is stamped during capture and needs no rebuild. A mixed history that is not the current transcript's prefix still needs the repair below.

```sh
lcm import --provider claude --rebuild            # preview; same as --dry-run
lcm import --provider claude --rebuild --yes      # back up, then rebuild
lcm import --provider claude --rebuild --session <id> --yes
```

`--rebuild` checks every Claude Code session compaction wrote into or whose parser-shape stamp is unknown or older, in the current project or with `--all` every tracked project, and aligns its stored messages with today's transcript parse in order, comparing role and content under the current redaction rules, with the same allowance for a removed pattern's `[REDACTED]` spans as capture. A stored message counts as lost only when it is absent from both today's parse and the older tool-content shape, which omitted tool-call name rows and `[tool error]` prefixes. For a session captured before role tagging (`role_tagging IS NULL`), this loss check compares content regardless of role: the older tool-content shape reproduces the pre-role-tagging parser's message content, whose tool outputs were stored as `user`. Gaps and extra stored rows are counted against today's parse, which is what the rebuild stores.

NUL characters in transcript message content become U+FFFD before storage. Comparison applies that normalization on both sides and accepts a stored row cut exactly at the transcript's first NUL, as older SQLite reads returned it. Such a cut row is repairable even when the rest of the session is aligned; rebuilding restores its full normalized text. A different prefix remains a mismatch.

Each session is reported as one of:

- **aligned**: role-tagged stored messages are the prefix of today's parse; any uncaptured tail is ordinary backlog, and capture updates an older stamp without replacing history. A session that predates role tagging is aligned while it has not grown: its stored messages match the older tool-content shape row for row and the transcript holds no newer entry, a tool call included.
- **repairable**: stored messages are not aligned, a row reads back cut at NUL, or a session that predates role tagging has grown, and every stored message appears in today's or the older tool-content shape. This includes a legacy prefix followed by a current-shape tail. The report counts the transcript messages missing from storage, the stored rows the current alignment could not place, and the leaf and condensed summaries a rebuild discards.
- **unavailable**: no transcript file. Report only.
- **ambiguous**: a stored message neither tool-content shape holds, or a session is stored as several conversations. A rebuild would lose content or cannot compare, so it is reported and left alone.

Without `--yes` nothing is written and the daemon is not started. With `--yes`, each repairable session goes to the daemon, which runs it in the project's queue so it never interleaves with a live capture or a compaction of that project. Before the first rebuild in a project, the daemon writes a consistent copy of the project database, write-ahead log included, next to it as `db.sqlite.bak-rebuild-<timestamp>`, and prints its path. Once the new copy completes, the project keeps it and its oldest rebuild backup, the database as it was before any rebuild; the backups in between are removed and each removed path is printed. A failed copy leaves older backups untouched and nothing in that project is rebuilt. At most two copies per project bound disk use while keeping both the latest recovery point and the one from before every repair. On Node 22.16 and later, the copy runs in short asynchronous page batches while the project's mutation lease prevents daemon writes from interleaving; an external writer makes SQLite restart the copy rather than mix database states. Earlier supported Node 22 releases use a synchronous copy. The daemon repeats the classification before changing anything, and then, in one transaction per session, deletes the conversation's summaries, context items, messages and their full-text entries and the session's `--replay` progress, and captures the transcript from its first message. The conversation row, its subagent attribution, its large files and promoted memories stay; a failure rolls the session back. A rebuilt session has no compaction event rows left and has the current parser-shape stamp, so a second run does not select it.

`--rebuild` cannot be combined with `--replay` or `--restart`. Regenerate the discarded summaries with `lcm compact`, or with threaded context through `lcm import --provider claude --replay`, which summarises the rebuilt sessions again because their replay progress was cleared.

## Repairing Codex and OMP rows cut at NUL

Older captures could store a transcript message with a NUL so that SQLite reads returned only the text before its first NUL. Codex and OMP read transcripts by byte cursor, so their `--rebuild` mode repairs those rows in place:

```sh
lcm import --provider codex --rebuild             # preview
lcm import --provider omp --rebuild               # preview
lcm import --provider codex --rebuild --yes       # back up and repair
lcm import --provider omp --rebuild --session <id> --yes
```

Specify one provider; `--all` includes other projects. Without `--yes`, the command reads the stored messages and full transcript, lists the sessions and cut-row counts, and writes nothing. It matches rows to transcript messages by session identity, project, role, content, and position. Codex rows must match the transcript prefix. OMP rows match the live path by position; when a rewind left stored messages off that path, they must have a unique in-order match in the file. An ambiguous match is reported and left alone.

With `--yes`, the daemon repeats that check in the project's queue and mutation lease. It backs up the project database before each session it changes, then atomically replaces only the verified cut rows' message content and full-text entries with the scrubbed transcript text, with NUL changed to U+FFFD. Other message rows, summaries, conversations, and byte cursors stay as they are. A second run finds no cut rows.
