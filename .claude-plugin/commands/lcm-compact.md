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

If `lcm` is not on PATH (marketplace install), use the plugin-relative binary instead:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs" compact
```

### Options

Pass user-specified flags through to the command:
- `--all` — Compact all tracked projects (default: current project only)
- `--dry-run` — Preview without writing
- `--replay` — Compact sessions sequentially with threaded context; resumes recorded progress
- `--restart` — Discard recorded replay progress and start from scratch
- `--no-promote` — Skip the automatic promote step
- `--verbose` — Show per-session token details

For example:
- `/lcm-compact --all` → `lcm compact --all`
- `/lcm-compact --dry-run` → `lcm compact --dry-run`
- `/lcm-compact --replay` → `lcm compact --replay`

Display the output verbatim.
