---
name: lcm-compact
description: Compact conversation messages into DAG summary nodes.
user_invocable: true
---

# /lcm-compact

Compact unprocessed conversation messages into summarized DAG nodes.

## Instructions

Run the following command via Bash:

```bash
lcm compact
```

### Options

Pass user-specified flags through to the command:
- `--all` — Compact all projects (default: current project only). Forces batch compaction mode regardless of TTY environment, ensuring reliable behavior in automated tools.
- `--dry-run` — Preview without writing

For example:
- `/lcm-compact --all` → `lcm compact --all`
- `/lcm-compact --dry-run` → `lcm compact --dry-run`

Display the output verbatim.
