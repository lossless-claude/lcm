---
name: lcm-import
description: Import Claude Code session transcripts into lcm memory
user_invocable: true
---

# /lcm-import

Import Claude Code session transcripts into lcm memory.

## Binary Resolution

If `lcm` is not on PATH, use the plugin's bundled binary instead:

```bash
node ~/.claude/plugins/cache/*/lossless-claude/*/lcm.mjs
```

Replace `lcm` with the command above in all instructions below.

## Instructions

Run the following command via Bash:

```bash
lcm import
```

### Options

If the user specifies options, append them to the command:
- `--all` — Import all projects instead of just the current project
- `--verbose` — Show per-session details
- `--dry-run` — Preview without writing
- `--replay` — Re-import all sessions in chronological order and compact each one immediately, threading context between sessions to build a temporal summary DAG. Use to rebuild memory from scratch.

For example:
- `/lcm-import --all` → `lcm import --all`
- `/lcm-import --all --verbose` → `lcm import --all --verbose`
- `/lcm-import --dry-run` → `lcm import --dry-run`
- `/lcm-import --replay` → `lcm import --replay`

Display the output verbatim.

After importing, suggest running `lcm compact` to summarize the imported sessions (or `lcm compact --all` if `--all` was used with import). Note: when `--replay` is used, compaction is performed inline — no separate compact step is needed.

## When to use

- After installing lcm for the first time (backfill existing sessions)
- After a session that failed to ingest (hook error, daemon down)
- To recover lost conversations
- After upgrading lcm (ensure all sessions are captured)

## Commands

- `lcm import` — import current project's sessions
- `lcm import --all` — import all projects
- `lcm import --verbose` — show per-session details
- `lcm import --dry-run` — preview without writing
- `lcm compact --all` — summarize all uncompacted sessions (run after import)
