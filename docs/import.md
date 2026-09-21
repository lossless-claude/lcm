# Import past sessions

`lcm import` imports Claude Code, Codex, and Oh My Pi session transcripts for the current project. `lcm import --replay` discovers and replays all three sources by default. Choose a source explicitly when needed:

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

`--provider` accepts `claude`, `codex`, `omp`, or `all`. The default is `all` with `--replay`, and `claude` otherwise. `--codex` is an alias for `--provider codex`, and `--omp` is an alias for `--provider omp`. An explicit source overrides the replay default. This selects transcript sources, independently of the model used to summarize them. Without `--all`, only the current project is selected. With `--all`, Claude imports tracked projects, Codex imports all projects identified in its transcripts, and OMP imports all discovered sessions whose working directory identifies a project.

Codex discovery reads `~/.codex/sessions/` and `~/.codex/archived_sessions/` recursively, including dated `YYYY/MM/DD/rollout-*.jsonl` files and legacy layouts. It uses `session_meta.id` as session identity, falling back to the filename for older transcripts. If several files represent the same session, the latest modification time wins; an archive wins an equal-time tie. Discovery reads only the metadata header (up to 1 MiB), rather than loading every conversation. Files without a working directory in that header's `session_meta.cwd` are skipped rather than assigned to an unrelated project. Symlinks are not followed.

OMP discovery reads `<agentDir>/sessions/<encoded-cwd>/`, where `<agentDir>` is `PI_CODING_AGENT_DIR` when set or `~/.omp/agent` otherwise. The session id comes from the id in the session-file header, and the transcript file is selected through OMP's session manager. Archived `.jsonl.gz` OMP sessions are not imported. Symlinks are not followed.

`--dry-run` lists the selected session count without starting the daemon, importing messages, or calling a model. Add `--verbose` for session identities. The count includes previously imported sessions; it describes selection, not new messages.

`lcm compact --replay` operates on conversations already stored in LCM, including Codex and OMP conversations. It does not scan transcript directories. Use `lcm import --replay` to discover historical files that LCM has not captured yet.

Codex and OMP import and live capture share a durable byte cursor. A repeated import reads only the appended suffix when its checkpoint is valid. OMP, like Codex, resumes from that cursor and does not take the already-ingested shortcut. File replacement, truncation, or growth after a previously imported final record without a newline requires a recovery scan. Cursor updates commit with message writes, so failed requests remain retryable without skipping or duplicating stored messages.

A recovery scan must match the stored message prefix after current redaction rules are applied to both sides. If the file is shorter or its prior messages differ, ingestion fails without advancing the checkpoint. Restore the complete original transcript and compatible redaction rules before retrying; an unrelated replacement must not reuse the existing session's history. Bounded fingerprints detect changes in the first and last 4 KiB of the checkpointed prefix; rewrites confined to the unsampled middle remain outside the stable-prefix contract.

`--replay` compacts selected sessions with context from earlier sessions in that project and source, resuming recorded progress on repeated runs. Replay context never crosses between projects or transcript sources. Codex imports and lifecycle hooks use the same session identity and ingestion path: repeated captures do not duplicate messages, while later transcript growth remains ingestible. User and assistant message text is extracted from Codex `response_item` records. A tool call becomes a `role: "tool"` message carrying only the tool's name (`arguments`/`input` are not stored), and a tool output becomes a `role: "tool"` message carrying its text. UI-projection event notifications are not imported, because they would duplicate the response items. OMP sessions use the session-file header identity and the same cursor-backed ingestion path for live capture and historical import. LCM's internal Codex summarizer runs without hooks and with ephemeral sessions, so its own work does not become future replay input.
