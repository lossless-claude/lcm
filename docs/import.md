# Import past sessions

`lcm import` imports Claude Code sessions for the current project. Choose Codex or both sources explicitly:

```sh
lcm import --provider codex --dry-run
lcm import --provider codex --replay
lcm import --provider all --all --dry-run
```

`--provider` accepts `claude` (default), `codex`, or `all`. This selects transcript sources, independently of the model used to summarize them. Without `--all`, only the current project is selected. With `--all`, Claude imports tracked projects and Codex imports all projects identified in its transcripts.

Codex discovery reads `~/.codex/sessions/` and `~/.codex/archived_sessions/` recursively, including dated `YYYY/MM/DD/rollout-*.jsonl` files and legacy layouts. It uses `session_meta.id` as session identity, falling back to the filename for older transcripts. If several files represent the same session, the latest modification time wins; an archive wins an equal-time tie. Discovery reads only the metadata header (up to 1 MiB), rather than loading every conversation. Files without a working directory in that header's `session_meta.cwd` are skipped rather than assigned to an unrelated project. Symlinks are not followed.

`--dry-run` lists the selected session count without starting the daemon, importing messages, or calling a model. Add `--verbose` for session identities. The count includes previously imported sessions; it describes selection, not new messages.

`--replay` compacts each selected session, including previously imported sessions, with context from earlier sessions in that project and source. Replay context never crosses between Codex projects. Ordinary imports skip fully ingested sessions. User and assistant message text is extracted from Codex response events; duplicate event notifications and tool events are not imported as messages.
