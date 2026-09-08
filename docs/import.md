# Import past sessions

`lcm import` imports Claude Code sessions for the current project. `lcm import --replay` discovers and replays both Claude and Codex sessions by default. Choose a source explicitly when needed:

```sh
lcm import --provider codex --dry-run
lcm import --replay --dry-run
lcm import --replay
lcm import --provider codex --replay
lcm import --provider all --all --dry-run
```

`--provider` accepts `claude`, `codex`, or `all`. The default is `all` with `--replay`, and `claude` otherwise. `--codex` is an alias for `--provider codex`. An explicit source overrides the replay default. This selects transcript sources, independently of the model used to summarize them. Without `--all`, only the current project is selected. With `--all`, Claude imports tracked projects and Codex imports all projects identified in its transcripts.

Codex discovery reads `~/.codex/sessions/` and `~/.codex/archived_sessions/` recursively, including dated `YYYY/MM/DD/rollout-*.jsonl` files and legacy layouts. It uses `session_meta.id` as session identity, falling back to the filename for older transcripts. If several files represent the same session, the latest modification time wins; an archive wins an equal-time tie. Discovery reads only the metadata header (up to 1 MiB), rather than loading every conversation. Files without a working directory in that header's `session_meta.cwd` are skipped rather than assigned to an unrelated project. Symlinks are not followed.

`--dry-run` lists the selected session count without starting the daemon, importing messages, or calling a model. Add `--verbose` for session identities. The count includes previously imported sessions; it describes selection, not new messages.

`lcm compact --replay` operates on conversations already stored in LCM, including Codex conversations. It does not scan transcript directories. Use `lcm import --replay` to discover historical files that LCM has not captured yet.

Codex import and live capture share a durable byte cursor. A repeated import reads only the appended suffix when its checkpoint is valid. File replacement, truncation, or growth after a previously imported final record without a newline requires a recovery scan. Cursor updates commit with message writes, so failed requests remain retryable without skipping or duplicating stored messages.

`--replay` compacts selected sessions with context from earlier sessions in that project and source, resuming recorded progress on repeated runs. Replay context never crosses between Codex projects. Codex imports and lifecycle hooks use the same session identity and ingestion path: repeated captures do not duplicate messages, while later transcript growth remains ingestible. User and assistant message text is extracted from Codex response events; duplicate event notifications and tool events are not imported as messages. LCM's internal Codex summarizer runs without hooks and with ephemeral sessions, so its own work does not become future replay input.
