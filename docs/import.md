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

`--dry-run` lists the selected session count without starting the daemon, importing messages, or calling a model. Add `--verbose` for session identities. The count includes previously imported sessions; it describes selection, not new messages.

`lcm compact --replay` operates on conversations already stored in LCM, including Codex and OMP conversations. It does not scan transcript directories. Use `lcm import --replay` to discover historical files that LCM has not captured yet.

Codex and OMP import and live capture share a durable byte cursor. A repeated import reads only the appended suffix when its checkpoint is valid. OMP, like Codex, resumes from that cursor and does not take the already-ingested shortcut. File replacement, truncation, or growth after a previously imported final record without a newline requires a recovery scan. Cursor updates commit with message writes, so failed requests remain retryable without skipping or duplicating stored messages. An archived OMP `.jsonl.gz` session is the one exception: it is not append-only, so it carries no cursor and is re-read in full on every import; the already-stored check that every source uses keeps that idempotent.

A recovery scan must match the stored message prefix after current redaction rules are applied to both sides; a stored `[REDACTED]` span left by a pattern since removed or narrowed matches the text it replaced. If the file is shorter or its prior messages differ, ingestion fails without advancing the checkpoint. An OMP session file is a tree whose abandoned branches stay in the file (see [Oh My Pi setup](omp.md#session-identity-and-transcript-layout)), so for OMP stored messages that are a prefix of the file's live path continue that path; otherwise they must appear in the file in order rather than as its prefix, and the scan adds the live-path messages that follow the last stored one. Restore the complete original transcript and compatible redaction rules before retrying; an unrelated replacement must not reuse the existing session's history. Bounded fingerprints detect changes in the first and last 4 KiB of the checkpointed prefix; rewrites confined to the unsampled middle remain outside the stable-prefix contract.

`--replay` compacts selected sessions with context from earlier sessions in that project and source, resuming recorded progress on repeated runs. Replay context never crosses between projects or transcript sources. Codex imports and lifecycle hooks use the same session identity and ingestion path: repeated captures do not duplicate messages, while later transcript growth remains ingestible. User and assistant message text is extracted from Codex `response_item` records. A tool call becomes a `role: "tool"` message carrying only the tool's name (`arguments`/`input` are not stored), and a tool output becomes a `role: "tool"` message carrying its text. UI-projection event notifications are not imported, because they would duplicate the response items. OMP sessions use the session-file header identity and the same cursor-backed ingestion path for live capture and historical import. LCM's internal Codex summarizer runs without hooks and with ephemeral sessions, so its own work does not become future replay input.

## Rebuilding compacted Claude Code sessions

Before compaction stopped counting its own event rows as captured transcript messages, the capture of a Claude Code session after a compaction skipped as many transcript messages as the session held event rows, and the first capture after the fix stored the session's last messages a second time. Such a session holds gaps and a repeated tail until it is rebuilt. Capture now verifies a compacted session's stored messages against its transcript first, and stops capturing it, writing nothing, when they are not the transcript's prefix; the error names the rebuild.

```sh
lcm import --provider claude --rebuild            # preview; same as --dry-run
lcm import --provider claude --rebuild --yes      # back up, then rebuild
lcm import --provider claude --rebuild --session <id> --yes
```

`--rebuild` checks every Claude Code session compaction wrote into, in the current project or with `--all` every tracked project, and aligns its stored messages with its transcript in order, comparing role and content under the current redaction rules, with the same allowance for a removed pattern's `[REDACTED]` spans as capture. Each session is reported as one of:

- **aligned**: stored messages are the transcript's prefix; any uncaptured tail is ordinary backlog.
- **repairable**: they are not, and the transcript holds every stored message. The report counts the transcript messages missing from storage, the stored rows the alignment could not place, and the leaf and condensed summaries a rebuild discards.
- **unavailable**: no transcript file. Report only.
- **ambiguous**: a stored message the transcript does not hold, a session stored as several conversations, or a conversation captured before role tagging. A rebuild would lose content or cannot compare, so it is reported and left alone.

Without `--yes` nothing is written and the daemon is not started. With `--yes`, each repairable session goes to the daemon, which runs it in the project's queue so it never interleaves with a live capture or a compaction of that project. Before the first rebuild in a project, the daemon writes a consistent copy of the project database, write-ahead log included, next to it as `db.sqlite.bak-rebuild-<timestamp>`, and prints its path; if the copy fails, nothing in that project is rebuilt. On Node 22.16 and later, the copy runs in short asynchronous page batches while the project's mutation lease prevents daemon writes from interleaving; an external writer makes SQLite restart the copy rather than mix database states. Earlier supported Node 22 releases use a synchronous copy. The daemon repeats the classification before changing anything, and then, in one transaction per session, deletes the conversation's summaries, context items, messages and their full-text entries and the session's `--replay` progress, and captures the transcript from its first message. The conversation row, its subagent attribution, its large files and promoted memories stay; a failure rolls the session back. A rebuilt session has no compaction event rows left, so a second run does not select it.

`--rebuild` cannot be combined with `--replay` or `--restart`. Regenerate the discarded summaries with `lcm compact`, or with threaded context through `lcm import --provider claude --replay`, which summarises the rebuilt sessions again because their replay progress was cleared.
