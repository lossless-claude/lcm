---
name: lcm-compact
description: Compact conversation messages into DAG summary nodes.
user_invocable: true
---

# /lcm-compact

Compact unprocessed conversation messages into summarized DAG nodes.

## Binary Resolution

If `lcm` is not on PATH, use the plugin's bundled binary instead:

```bash
node ~/.claude/plugins/cache/*/lossless-claude/*/lcm.mjs
```

Replace `lcm` with the command above in all instructions below.

## Instructions

Run the following command via Bash:

```bash
lcm compact
```

### Options

Pass user-specified flags through to the command:
- `--all` — Compact all projects (default: current project only). Forces batch compaction mode regardless of TTY environment, ensuring reliable behavior in automated tools.
- `--dry-run` — Preview without writing
- `--replay` — Re-compact sessions that already have summaries (by default, already-compacted sessions are skipped)

For example:
- `/lcm-compact --all` → `lcm compact --all`
- `/lcm-compact --dry-run` → `lcm compact --dry-run`
- `/lcm-compact --replay` → `lcm compact --replay`

Display the output verbatim.
