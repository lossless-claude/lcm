---
name: lcm-import
description: Import Claude Code session transcripts into lcm memory
user_invocable: true
---

# /lcm-import

Import Claude Code session transcripts into lcm memory.

## Instructions

Run `lcm import` via Bash to import the current project's sessions. Display the output verbatim.

If the user wants to import all projects, run `lcm import --all --verbose`.

After importing, suggest running `lcm compact --all` to summarize the imported sessions.

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
