---
name: lcm-promote
description: Promote durable insights from summaries into cross-session memory.
user_invocable: true
---

# /lcm-promote

Promote durable insights from summaries into cross-session memory.

## Instructions

Run the following command via Bash:

```bash
lcm promote
```

### Options

Pass user-specified flags through to the command:
- `--all` — Promote across all projects (default: current project only)
- `--verbose` — Show per-conversation details
- `--dry-run` — Preview without writing

For example:
- `/lcm-promote --all` → `lcm promote --all`
- `/lcm-promote --verbose` → `lcm promote --verbose`
- `/lcm-promote --dry-run` → `lcm promote --dry-run`

Display the output verbatim.
